param(
    [string]$VaultRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$today = Get-Date -Format 'yyyy-MM-dd'

function Get-NoteType([string]$relativePath, [string]$baseName) {
    $path = $relativePath.Replace('\', '/')
    if ($path.StartsWith('_moc/') -or $baseName -match '(^MOC-|MOC$|00-Hub|00-Overview|Roadmap|Lộ-trình|Curriculum)') { return 'moc' }
    if ($baseName -match '^ADR-' -or $baseName -match 'Decision-Matrix|Strategy-Comparison') { return 'decision' }
    if ($path.StartsWith('concepts/')) { return 'concept' }
    if ($path.StartsWith('Notion Knowledge/')) { return 'reference' }
    if ($baseName -match 'Project|PDMS') { return 'project' }
    if ($path -match '(Zero-To-Hero|Latest-Series|JVM-Frameworks-2026|Apache-Fory|Design-Patterns-)') { return 'course' }
    return 'guide'
}

function Get-Domain([string]$relativePath) {
    $path = $relativePath.Replace('\', '/')
    switch -Regex ($path) {
        '^Angular-Latest-Series/' { return 'frontend/angular' }
        '^React-Latest-Series/' { return 'frontend/react' }
        '^SolidJS-Series/' { return 'frontend/solidjs' }
        '^Rust-Zero-To-Hero/' { return 'languages/rust' }
        '^Go-Zero-To-Hero/' { return 'languages/go' }
        '^JVM-Frameworks-2026/' { return 'languages/jvm' }
        '^Database-Patterns/' { return 'database' }
        '^Microservices-Patterns/' { return 'architecture/microservices' }
        '^Performance-System-Programming/' { return 'systems/performance' }
        '^Design-Patterns-Rust/' { return 'architecture/design-patterns/rust' }
        '^Design-Patterns-Go/' { return 'architecture/design-patterns/go' }
        '^Apache-Fory/' { return 'data/serialization' }
        '^Notion Knowledge/' { return 'reference-library' }
        '^concepts/' { return 'concepts' }
        '^_moc/' { return 'knowledge-management' }
        '^_templates/' { return 'knowledge-management' }
        default { return 'knowledge-management' }
    }
}

function Add-MissingMetadata(
    [string]$raw,
    [System.IO.FileInfo]$file,
    [string]$relativePath
) {
    $normalized = $raw.Replace("`r`n", "`n")
    $type = Get-NoteType $relativePath $file.BaseName
    $domain = Get-Domain $relativePath
    $created = $file.CreationTime.ToString('yyyy-MM-dd')
    $updated = $file.LastWriteTime.ToString('yyyy-MM-dd')

    $required = [ordered]@{
        type = $type
        domain = $domain
        status = 'active'
        created = $created
        updated = $updated
        tags = '[]'
    }
    if ($relativePath.Replace('\', '/').StartsWith('Notion Knowledge/')) {
        $required['distillation'] = 'reference'
    }

    if ($normalized.StartsWith("---`n")) {
        $closing = $normalized.IndexOf("`n---", 4)
        if ($closing -lt 0) { throw "Frontmatter không đóng: $relativePath" }
        $frontmatter = $normalized.Substring(4, $closing - 4)
        $body = $normalized.Substring($closing + 4)
        $additions = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in $required.GetEnumerator()) {
            if ($frontmatter -notmatch "(?m)^$([regex]::Escape($entry.Key))\s*:") {
                $additions.Add("$($entry.Key): $($entry.Value)")
            }
        }
        if ($additions.Count -eq 0) { return $normalized }
        $frontmatter = $frontmatter.TrimEnd("`n")
        return "---`n$frontmatter`n$($additions -join "`n")`n---$body"
    }

    $lines = foreach ($entry in $required.GetEnumerator()) {
        "$($entry.Key): $($entry.Value)"
    }
    return "---`n$($lines -join "`n")`n---`n`n$normalized"
}

$files = Get-ChildItem -LiteralPath $VaultRoot -Recurse -File -Filter '*.md' |
    Where-Object {
        $_.FullName -notmatch '\\\.obsidian\\|\\\.trash\\|\\_archive\\' -and
        $_.FullName -ne $PSCommandPath
    }

$changed = 0
foreach ($file in $files) {
    $relative = $file.FullName.Substring($VaultRoot.Length + 1)
    $raw = [System.IO.File]::ReadAllText($file.FullName)
    $result = Add-MissingMetadata $raw $file $relative
    if ($result -cne $raw.Replace("`r`n", "`n")) {
        [System.IO.File]::WriteAllText($file.FullName, $result, $utf8)
        $changed++
    }
}

Write-Output "Normalized metadata for $changed/$($files.Count) notes."
