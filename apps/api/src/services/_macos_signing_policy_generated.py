SOURCE_OWNER_SHA256 = "6a865ceda652aeb10b7de45f8cd45bbc67485ec6f50cbae7527f35d21ae577f1"

MACOS_SIGNERS = {
    "legacy": {
        "authority": "Developer ID Application: Peter Ciaccia (DGWRL53RQQ)",
        "teamId": "DGWRL53RQQ",
    },
    "humic": {
        "authority": "Developer ID Application: Humic Labs Inc. (Q2CH437K54)",
        "teamId": "Q2CH437K54",
    },
}

DEVELOPER_ID_REQUIREMENTS = {
    "legacy": (
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = DGWRL53RQQ"
    ),
    "humic": (
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = Q2CH437K54"
    ),
}
