param(
    [string]$VaultRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$allFiles = Get-ChildItem -LiteralPath $VaultRoot -Recurse -File -Filter '*.md' |
    Where-Object { $_.FullName -notmatch '\\\.obsidian\\|\\\.trash\\|\\_archive\\' }

$pathMap = @{}
$stemMap = @{}
foreach ($file in $allFiles) {
    $relative = $file.FullName.Substring($VaultRoot.Length + 1).Replace('\', '/')
    $withoutExtension = $relative.Substring(0, $relative.Length - 3)
    $pathMap[$withoutExtension.ToLowerInvariant()] = $relative
    $stem = $file.BaseName.ToLowerInvariant()
    if (-not $stemMap.ContainsKey($stem)) { $stemMap[$stem] = @() }
    $stemMap[$stem] += $relative
}

$navigationFiles = @(
    (Join-Path $VaultRoot 'HOME.md')
) + @(Get-ChildItem -LiteralPath (Join-Path $VaultRoot '_moc') -File -Filter '*.md' | ForEach-Object FullName)

$changed = 0
foreach ($path in $navigationFiles) {
    $raw = [System.IO.File]::ReadAllText($path)
    $result = [regex]::Replace($raw, '\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]', {
        param($match)
        $originalTarget = $match.Groups[1].Value.Trim()
        $target = $originalTarget.Replace('\', '/').TrimEnd('/')
        if ($target.EndsWith('.md')) { $target = $target.Substring(0, $target.Length - 3) }

        $resolved = $pathMap.ContainsKey($target.ToLowerInvariant())
        if (-not $resolved) {
            $stem = ($target -split '/')[-1].ToLowerInvariant()
            $resolved = $stemMap.ContainsKey($stem) -and $stemMap[$stem].Count -eq 1
        }
        if ($resolved) { return $match.Value }

        $label = if ($match.Groups[2].Success) {
            $match.Groups[2].Value
        } else {
            ($originalTarget -split '/')[-1]
        }
        return "$label *(planned)*"
    })

    if ($result -cne $raw) {
        [System.IO.File]::WriteAllText($path, $result, $utf8)
        $changed++
    }
}

Write-Output "Repaired unresolved navigation links in $changed files."
