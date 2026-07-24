param(
    [string]$VaultRoot = (Split-Path -Parent $PSScriptRoot)
)

$files = Get-ChildItem -LiteralPath $VaultRoot -Recurse -File -Filter '*.md' |
    Where-Object { $_.FullName -notmatch '\\\.obsidian\\|\\\.trash\\|\\_archive\\' }

$pathMap = @{}
$stemMap = @{}
foreach ($file in $files) {
    $relative = $file.FullName.Substring($VaultRoot.Length + 1).Replace('\', '/')
    $withoutExtension = $relative.Substring(0, $relative.Length - 3)
    $pathMap[$withoutExtension.ToLowerInvariant()] = $relative
    $stem = $file.BaseName.ToLowerInvariant()
    if (-not $stemMap.ContainsKey($stem)) { $stemMap[$stem] = @() }
    $stemMap[$stem] += $relative
}

$unresolved = @()
foreach ($file in $files) {
    $source = $file.FullName.Substring($VaultRoot.Length + 1).Replace('\', '/')
    $raw = [System.IO.File]::ReadAllText($file.FullName)
    foreach ($match in [regex]::Matches($raw, '\[\[([^\]|#]+)')) {
        $target = $match.Groups[1].Value.Trim().Replace('\', '/').TrimEnd('/')
        if ($target.EndsWith('.md')) { $target = $target.Substring(0, $target.Length - 3) }
        $resolved = $pathMap.ContainsKey($target.ToLowerInvariant())
        if (-not $resolved) {
            $stem = ($target -split '/')[-1].ToLowerInvariant()
            $resolved = $stemMap.ContainsKey($stem) -and $stemMap[$stem].Count -eq 1
        }
        if (-not $resolved) {
            $unresolved += [pscustomobject]@{ Source = $source; Target = $target }
        }
    }
}

$unresolved | Sort-Object Source, Target
Write-Output "Unresolved links: $($unresolved.Count)"
