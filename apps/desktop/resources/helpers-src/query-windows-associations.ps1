param([Parameter(Mandatory = $true)][string] $Extensions)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("4e530b0a-e611-4c77-a3ac-9031d022281b"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationAssociationRegistration {
    [PreserveSig] int QueryCurrentDefault(
        [MarshalAs(UnmanagedType.LPWStr)] string extension,
        int associationType, int level,
        [MarshalAs(UnmanagedType.LPWStr)] out string progId);
}

public static class FileAssociationReader {
    public static string Read(string extension) {
        var clsid = new Guid("591209c7-767b-42b2-9fba-44ee4615f2c7");
        var reader = (IApplicationAssociationRegistration)Activator.CreateInstance(Type.GetTypeFromCLSID(clsid));
        try {
            string progId;
            int hr = reader.QueryCurrentDefault(extension, 0, 1, out progId);
            if (hr == unchecked((int)0x80070483)) return null;
            Marshal.ThrowExceptionForHR(hr);
            return progId;
        } finally {
            Marshal.ReleaseComObject(reader);
        }
    }
}
'@
$result = [ordered]@{}
foreach ($extension in $Extensions.Split(',')) {
    if ($extension -notmatch '^[a-z0-9]+$') { throw 'Invalid filename extension.' }
    $result[$extension] = [FileAssociationReader]::Read(".$extension")
}
$result | ConvertTo-Json -Compress
