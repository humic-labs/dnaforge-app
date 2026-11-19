# Desktop notices across relaunch

Use a disposable profile. Keep the same profile and workspace for both launches
in each case, and record the app version and process ID on each launch. Capture
the first notice, the click, and the result after starting a new process.

## Release updates

1. Launch a released version with a new profile. The app should open without an
   update announcement.
2. Upgrade to a release with published release notes and open the same profile.
   Confirm the announcement names the new version. Click its close button and
   quit the app.
3. Reopen the same version. Confirm the workspace opens without repeating the
   announcement. Repeat when upgrading to the next release with published notes.
4. For a profile from before the SQLite migration, repeat with its original
   `.last-seen-version` file. After the first upgraded launch, the
   `last_seen_release_version` setting in the profile's SQLite database should
   contain the running version.

## Usage analytics

Use a build with a configured telemetry destination. A loopback destination is
sufficient for a development run. Exercise the opt-in prompt in a European time
zone, using a separate fresh profile for each gesture.

1. Close the prompt using **×**. Quit and reopen. Confirm the prompt stays
   dismissed and analytics remains off.
2. Repeat with **Share**. Confirm sharing stays enabled after reopening and
   neither analytics notice appears. Repeat with **Don't share** and confirm
   sharing stays disabled.
3. Leave the prompt untouched in a fresh profile, quit, and reopen. Confirm the
   prompt returns and sharing remains off.
4. In an opt-out region, click the informational notice's **×** or its
   **Click to dismiss** surface. Reopen and confirm it stays dismissed.

Read `analytics_banner_seen` and `analytics_consent` in the isolated profile's
SQLite database. The former records acknowledgment. The latter records the
consent decision. Closing the opt-in prompt must leave analytics disabled.
