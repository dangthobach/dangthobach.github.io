import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const outputDirectory = path.resolve(process.argv[2] ?? "public")
const siteOrigin = "https://quartz.local"
const publishedBasePath = "/knowledge"

const toPosix = (value) => value.split(path.sep).join("/")

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name)
      return entry.isDirectory() ? walk(absolutePath) : absolutePath
    }),
  )
  return files.flat()
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function extractReferences(html) {
  const references = []
  const tagPattern = /<(a|link|img|script|source|video|audio|iframe)\b[^>]*>/gi
  const attributePattern = /\b(href|src)\s*=\s*(["'])(.*?)\2/i

  for (const match of html.matchAll(tagPattern)) {
    const attribute = match[0].match(attributePattern)
    if (attribute) references.push(decodeHtml(attribute[3].trim()))
  }

  return references
}

function extractAnchors(html) {
  const anchors = new Set()
  const anchorPattern = /\b(?:id|name)\s*=\s*(["'])(.*?)\1/gi
  for (const match of html.matchAll(anchorPattern)) {
    anchors.add(decodeHtml(match[2]))
  }
  return anchors
}

const allFiles = await walk(outputDirectory)
const relativeFiles = new Set(allFiles.map((file) => toPosix(path.relative(outputDirectory, file))))
const htmlFiles = allFiles.filter((file) => file.endsWith(".html"))
const htmlCache = new Map()

async function findTarget(pathname) {
  let decodedPath = safeDecode(pathname).replace(/^\/+/, "")
  if (decodedPath === publishedBasePath.slice(1)) decodedPath = ""
  if (decodedPath.startsWith(`${publishedBasePath.slice(1)}/`)) {
    decodedPath = decodedPath.slice(publishedBasePath.length)
  }

  const normalized = path.posix.normalize(decodedPath || ".").replace(/^\.\/?/, "")
  const candidates = normalized
    ? [normalized, `${normalized}.html`, `${normalized}/index.html`]
    : ["index.html"]

  if (normalized.endsWith("/")) candidates.unshift(`${normalized}index.html`)

  return candidates.find((candidate) => relativeFiles.has(candidate))
}

const broken = []
let checkedReferences = 0
let skippedExternal = 0

for (const sourceFile of htmlFiles) {
  const sourceRelative = toPosix(path.relative(outputDirectory, sourceFile))
  const sourceUrl = new URL(`/${sourceRelative}`, siteOrigin)
  const html = await readFile(sourceFile, "utf8")

  for (const reference of extractReferences(html)) {
    if (
      reference === "" ||
      reference.startsWith("data:") ||
      reference.startsWith("mailto:") ||
      reference.startsWith("tel:") ||
      reference.startsWith("javascript:")
    ) {
      continue
    }

    let targetUrl
    try {
      targetUrl = new URL(reference, sourceUrl)
    } catch {
      broken.push({ source: sourceRelative, reference, reason: "invalid URL" })
      continue
    }

    if (targetUrl.origin !== siteOrigin) {
      skippedExternal += 1
      continue
    }

    checkedReferences += 1
    const targetFile = await findTarget(targetUrl.pathname)
    if (!targetFile) {
      broken.push({ source: sourceRelative, reference, reason: "target not emitted" })
      continue
    }

    const fragment = safeDecode(targetUrl.hash.slice(1))
    if (!fragment) continue

    if (!targetFile.endsWith(".html")) {
      broken.push({ source: sourceRelative, reference, reason: "fragment targets a non-HTML file" })
      continue
    }

    let targetHtml = htmlCache.get(targetFile)
    if (!targetHtml) {
      targetHtml = await readFile(path.join(outputDirectory, targetFile), "utf8")
      htmlCache.set(targetFile, targetHtml)
    }

    if (!extractAnchors(targetHtml).has(fragment)) {
      broken.push({ source: sourceRelative, reference, reason: `missing #${fragment}` })
    }
  }
}

console.log(
  `Checked ${checkedReferences.toLocaleString()} internal references across ${htmlFiles.length.toLocaleString()} HTML files (${skippedExternal.toLocaleString()} external references skipped).`,
)

if (broken.length > 0) {
  console.error(`Found ${broken.length.toLocaleString()} broken internal references:`)
  for (const issue of broken.slice(0, 200)) {
    console.error(`- ${issue.source} -> ${issue.reference} (${issue.reason})`)
  }
  if (broken.length > 200) console.error(`...and ${broken.length - 200} more.`)
  process.exitCode = 1
} else {
  console.log("All internal page, asset, and heading links resolve successfully.")
}
