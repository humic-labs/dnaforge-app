import hashlib
import json
import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.app_owned_tool_identity import (
    AppOwnedToolIdentityError,
    _publisher,
    resolve_app_owned_executable,
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class AppOwnedIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / "Test.app"
        self.helpers = self.app / "Contents" / "Helpers"
        self.helpers.mkdir(parents=True)
        self.tool = self.helpers / "tool"
        self.tool.write_bytes(b"unsigned")
        self.tool.chmod(0o755)
        self.receipt = self.helpers / "receipt.json"
        self.receipt.write_bytes(b"{}")
        self.args = {
            "source_build_sha256": digest(b"unsigned"),
            "source_receipt_name": "receipt.json",
            "source_receipt_sha256": digest(b"{}"),
        }
        env = patch.dict(os.environ, {"DNAFORGE_HELPERS_DIR": str(self.helpers)})
        env.start()
        self.addCleanup(env.stop)

    def resolve(self):
        return resolve_app_owned_executable("tool", **self.args)

    def seal(self):
        self.tool.write_bytes(b"signed")
        publisher = {
            "mode": "humic",
            "authority": "Developer ID Application: Humic Labs Inc. (Q2CH437K54)",
            "teamId": "Q2CH437K54",
        }
        document = {
            "schema": "dnaforge.app-owned-tools-signing.v1",
            "phase": "existing-signer-before-containing-app-seal",
            "bundleIdentifier": "com.test.app",
            "packageAuthority": {**publisher, "publisherVerified": True},
            "tools": {
                "tool": {
                    "sourceBuildSha256": self.args["source_build_sha256"],
                    "sourceReceiptFile": "receipt.json",
                    "sourceReceiptSha256": self.args["source_receipt_sha256"],
                    "signedSha256": digest(b"signed"),
                }
            },
        }
        resources = self.app / "Contents" / "Resources"
        resources.mkdir()
        handoff = resources / "app-owned-tools.signing.json"
        handoff.write_text(json.dumps(document))
        signature = self.app / "Contents" / "_CodeSignature"
        signature.mkdir()
        (signature / "CodeResources").write_bytes(
            plistlib.dumps(
                {
                    "files2": {
                        "Resources/app-owned-tools.signing.json": {
                            "hash2": hashlib.sha256(handoff.read_bytes()).digest()
                        }
                    }
                }
            )
        )
        (self.app / "Contents" / "Info.plist").write_bytes(
            plistlib.dumps({"CFBundleIdentifier": "com.test.app"})
        )
        return handoff, publisher

    def test_exact_bytes_inside_unsealed_app_do_not_become_developer_mode(self):
        with self.assertRaises(AppOwnedToolIdentityError):
            self.resolve()

    def test_bundle_filename_cannot_downgrade_packaged_helpers_to_developer_mode(self):
        for name in ("Renamed.APP", "RenamedBundle"):
            with self.subTest(name=name):
                renamed = self.app.with_name(name)
                self.app.rename(renamed)
                self.app = renamed
                self.helpers = renamed / "Contents" / "Helpers"
                os.environ["DNAFORGE_HELPERS_DIR"] = str(self.helpers)
                with self.assertRaises(AppOwnedToolIdentityError):
                    self.resolve()

    def test_packaged_helpers_symlink_cannot_escape_to_exact_developer_bytes(self):
        external = Path(self.temp.name) / "developer" / "helpers"
        external.parent.mkdir()
        self.helpers.rename(external)
        self.helpers.symlink_to(external, target_is_directory=True)
        with patch("services.app_owned_tool_identity._codesign") as signer:
            with self.assertRaisesRegex(
                AppOwnedToolIdentityError, "escaped the containing app"
            ):
                self.resolve()
        signer.assert_not_called()

    def test_packaged_contents_symlink_cannot_escape_to_exact_developer_bytes(self):
        external = Path(self.temp.name) / "developer"
        contents = self.app / "Contents"
        contents.rename(external)
        contents.symlink_to(external, target_is_directory=True)
        with patch("services.app_owned_tool_identity._codesign") as signer:
            with self.assertRaisesRegex(
                AppOwnedToolIdentityError, "escaped the containing app"
            ):
                self.resolve()
        signer.assert_not_called()

    def test_alias_of_whole_signed_app_keeps_its_canonical_package_owner(self):
        _, publisher = self.seal()
        alias = Path(self.temp.name) / "Alias.app"
        alias.symlink_to(self.app, target_is_directory=True)
        with (
            patch.dict(
                os.environ,
                {"DNAFORGE_HELPERS_DIR": str(alias / "Contents" / "Helpers")},
            ),
            patch("services.app_owned_tool_identity._codesign"),
            patch(
                "services.app_owned_tool_identity._publisher", return_value=publisher
            ),
        ):
            identity = self.resolve()
        self.assertEqual(identity.path, self.tool.resolve())
        self.assertEqual(identity.verification_type, "sealed-package-signing-handoff")

    def test_exact_bytes_need_no_signing_claim(self):
        developer = Path(self.temp.name) / "developer-helpers"
        self.helpers.rename(developer)
        os.environ["DNAFORGE_HELPERS_DIR"] = str(developer)
        with patch("services.app_owned_tool_identity._codesign") as signer:
            identity = self.resolve()
        signer.assert_not_called()
        self.assertEqual(identity.verification_type, "exact-source-build-bytes")
        self.assertIsNone(identity.package_identity)

    def test_changed_bytes_require_handoff_and_seal(self):
        self.tool.write_bytes(b"changed")
        with self.assertRaises(AppOwnedToolIdentityError):
            self.resolve()

    def test_signed_bytes_keep_separate_identity_and_require_signatures(self):
        _, publisher = self.seal()
        with (
            patch("services.app_owned_tool_identity._codesign") as signer,
            patch(
                "services.app_owned_tool_identity._publisher", return_value=publisher
            ),
        ):
            identity = self.resolve()
        signer.assert_called_once_with(
            self.app.resolve(), "--verify", "--deep", "--strict"
        )
        self.assertEqual(identity.verification_type, "sealed-package-signing-handoff")
        self.assertNotEqual(identity.sha256, identity.source_build_sha256)
        self.assertEqual(identity.package_identity["bundleIdentifier"], "com.test.app")

    def test_unsealed_tampered_handoff_rejected_before_publisher_probe(self):
        handoff, _ = self.seal()
        handoff.write_text(handoff.read_text() + " ")
        with patch("services.app_owned_tool_identity._codesign") as signer:
            with self.assertRaisesRegex(AppOwnedToolIdentityError, "resource seal"):
                self.resolve()
        signer.assert_not_called()

    def test_matching_self_signed_display_still_needs_apple_requirement(self):
        display = "Authority=Developer ID Application: Humic Labs Inc. (Q2CH437K54)\nTeamIdentifier=Q2CH437K54\n"
        calls = []

        def probe(path, *flags):
            calls.append(flags)
            if "--display" in flags:
                return display
            if "-R" in flags:
                raise subprocess.CalledProcessError(
                    1, "codesign", stderr="Apple anchor mismatch"
                )
            return ""

        with patch("services.app_owned_tool_identity._codesign", side_effect=probe):
            with self.assertRaises(subprocess.CalledProcessError):
                _publisher(self.tool)
        requirement = calls[-1][-1]
        self.assertIn("anchor apple generic", requirement)
        self.assertIn(
            "certificate 1[field.1.2.840.113635.100.6.2.6] exists", requirement
        )
        self.assertIn(
            "certificate leaf[field.1.2.840.113635.100.6.1.13] exists", requirement
        )
        self.assertTrue(
            requirement.endswith("certificate leaf[subject.OU] = Q2CH437K54")
        )

    def test_sealed_handoff_rejects_package_and_helper_publisher_mismatch(self):
        _, publisher = self.seal()
        different = {**publisher, "teamId": "DGWRL53RQQ"}
        with (
            patch("services.app_owned_tool_identity._codesign"),
            patch(
                "services.app_owned_tool_identity._publisher",
                side_effect=[publisher, different],
            ),
        ):
            with self.assertRaisesRegex(
                AppOwnedToolIdentityError, "publisher does not match"
            ):
                self.resolve()

    def test_receipt_and_executable_symlinks_rejected(self):
        original = self.helpers / "original"
        self.tool.rename(original)
        self.tool.symlink_to(original)
        with self.assertRaises(AppOwnedToolIdentityError):
            self.resolve()

    def test_missing_helpers_never_searches_path(self):
        with (
            patch.dict(os.environ, {"DNAFORGE_HELPERS_DIR": ""}),
            patch("services.app_owned_tool_identity.subprocess.run") as run,
        ):
            with self.assertRaises(AppOwnedToolIdentityError):
                self.resolve()
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
