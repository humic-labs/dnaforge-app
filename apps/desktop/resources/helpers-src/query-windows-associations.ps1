param([Parameter(Mandatory = $true)][string] $Extensions)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("4e530b0a-e611-4c77-a3ac-9031d022281b"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationAssociationRegistration {
    [PreserveSig] int QueryCurrentDefault(
        [MarshalAs(UnmanagedType.LPWStr)] string extension,
        int associationType, int level,
        [MarshalAs(UnmanagedType.LPWStr)] out string progId);
}

public static class FileAssociationReader {
    [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int AssocQueryStringW(uint flags, int query, string extension, string extra,
        StringBuilder output, ref uint size);
    public static string FriendlyName(string extension, string fallback) {
        uint size = 0;
        AssocQueryStringW(0, 4, extension, null, null, ref size);
        if (size == 0 || size > 32768) return fallback;
        var name = new StringBuilder((int)size);
        return AssocQueryStringW(0, 4, extension, null, name, ref size) == 0 ? name.ToString() : fallback;
    }
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
    $id = [FileAssociationReader]::Read(".$extension")
    $result[$extension] = if ($null -ne $id -and $id.Length) {
        @{ progId = $id; name = [FileAssociationReader]::FriendlyName(".$extension", $id) }
    } else { $null }
}
$result | ConvertTo-Json -Compress
