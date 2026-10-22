<#
Windows Credential Manager helper for the release script (scripts/release-publish.mjs).

  store   save the GitHub token under a generic credential
  get     print the stored token on stdout (nothing else is written to stdout)
  delete  remove the entry

Default target: pulsar-manager:github-token

The token lives only in Credential Manager: it is never written to a file and,
when storing interactively (default), never appears on the command line or in
the shell history. -Token exists for non-interactive tests only; do not use it
with a real token.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('store', 'get', 'delete')]
    [string]$Action,

    [string]$Target = 'pulsar-manager:github-token',

    [string]$UserName = 'lingfeng983',

    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'

$typeDefinition = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class NativeCred
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);
}
'@

Add-Type -TypeDefinition $typeDefinition -ErrorAction Stop

$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2
$ERROR_NOT_FOUND = 1168

function Invoke-Store {
    param([string]$TargetName, [string]$Account, [string]$PlainToken)

    if ([string]::IsNullOrWhiteSpace($PlainToken)) {
        $secure = Read-Host -Prompt 'Paste the GitHub token (input is hidden)' -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $PlainToken = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        }
        finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    $PlainToken = $PlainToken.Trim()
    if ([string]::IsNullOrWhiteSpace($PlainToken)) {
        throw 'Empty token, nothing was stored.'
    }

    # Generic credentials keep an opaque blob; store the token as UTF-16LE so a
    # trailing NUL is not needed and the byte length is unambiguous.
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($PlainToken)

    $cred = New-Object -TypeName 'NativeCred+CREDENTIAL'
    $cred.Type = $CRED_TYPE_GENERIC
    $cred.TargetName = $TargetName
    $cred.UserName = $Account
    $cred.Comment = 'pulsar-manager release token'
    $cred.Persist = $CRED_PERSIST_LOCAL_MACHINE
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $cred.CredentialBlob, $bytes.Length)
        if (-not [NativeCred]::CredWrite([ref]$cred, 0)) {
            throw ('CredWrite failed, Win32 error ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob)
    }

    [Console]::Out.WriteLine("Stored credential '$TargetName' for user '$Account' ($($bytes.Length) bytes).")
}

function Invoke-Get {
    param([string]$TargetName)

    $ptr = [IntPtr]::Zero
    if (-not [NativeCred]::CredRead($TargetName, $CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
        throw ('CredRead failed for ' + $TargetName + ', Win32 error ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    try {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type]'NativeCred+CREDENTIAL')
        $size = [int]$cred.CredentialBlobSize
        if ($size -le 0) {
            return
        }
        $bytes = New-Object -TypeName 'byte[]' -ArgumentList $size
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $size)
        $text = [System.Text.Encoding]::Unicode.GetString($bytes).TrimEnd([char]0)
        [Console]::Out.Write($text)
    }
    finally {
        [NativeCred]::CredFree($ptr)
    }
}

function Invoke-Delete {
    param([string]$TargetName)

    if ([NativeCred]::CredDelete($TargetName, $CRED_TYPE_GENERIC, 0)) {
        [Console]::Out.WriteLine("Deleted credential '$TargetName'.")
        return
    }
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq $ERROR_NOT_FOUND) {
        [Console]::Out.WriteLine("Credential '$TargetName' did not exist.")
        return
    }
    throw ('CredDelete failed, Win32 error ' + $code)
}

switch ($Action) {
    'store' { Invoke-Store -TargetName $Target -Account $UserName -PlainToken $Token }
    'get' { Invoke-Get -TargetName $Target }
    'delete' { Invoke-Delete -TargetName $Target }
}