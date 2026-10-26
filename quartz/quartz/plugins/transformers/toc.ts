import { QuartzTransformerPlugin } from "../types"
import { Root as MdastRoot } from "mdast"
import { Element, Root as HtmlRoot } from "hast"
import { visit } from "unist-util-visit"
import { toString } from "mdast-util-to-string"
import Slugger from "github-slugger"

export interface Options {
  maxDepth: 1 | 2 | 3 | 4 | 5 | 6
  minEntries: number
  showByDefault: boolean
  collapseByDefault: boolean
}

const defaultOptions: Options = {
  maxDepth: 3,
  minEntries: 1,
  showByDefault: true,
  collapseByDefault: false,
}

interface TocEntry {
  depth: number
  text: string
  slug: string // this is just the anchor (#some-slug), not the canonical slug
}

const slugAnchor = new Slugger()
export const TableOfContents: QuartzTransformerPlugin<Partial<Options>> = (userOpts) => {
  const opts = { ...defaultOptions, ...userOpts }
  return {
    name: "TableOfContents",
    markdownPlugins() {
      return [
        () => {
          return async (tree: MdastRoot, file) => {
            const display = file.data.frontmatter?.enableToc ?? opts.showByDefault
            if (display) {
              slugAnchor.reset()
              const toc: TocEntry[] = []
              let highestDepth: number = opts.maxDepth
              visit(tree, "heading", (node) => {
                if (node.depth <= opts.maxDepth) {
                  const text = toString(node)
                  highestDepth = Math.min(highestDepth, node.depth)
                  toc.push({
                    depth: node.depth,
                    text,
                    slug: slugAnchor.slug(text),
                  })
                }
              })

              if (toc.length > 0 && toc.length > opts.minEntries) {
                file.data.toc = toc.map((entry) => ({
                  ...entry,
                  depth: entry.depth - highestDepth,
                }))
                file.data.collapseToc = opts.collapseByDefault
              }
            }
          }
        },
      ]
    },
    htmlPlugins() {
      return [
        () => (tree: HtmlRoot, file) => {
          if (!file.data.toc) return

          const headingIds: string[] = []
          visit(tree, "element", (node: Element) => {
            const depth = /^h([1-6])$/.exec(node.tagName)?.[1]
            if (
              depth !== undefined &&
              Number(depth) <= opts.maxDepth &&
              typeof node.properties?.id === "string"
            ) {
              headingIds.push(node.properties.id)
            }
          })

          // rehype-slug operates on the final HTML text, which can differ from
          // Markdown text for generics (`Option<T>`) and inline HTML. Treat the
          // emitted heading IDs as the source of truth for navigation.
          file.data.toc = file.data.toc.map((entry, index) => ({
            ...entry,
            slug: headingIds[index] ?? entry.slug,
          }))
        },
      ]
    },
  }
}

declare module "vfile" {
  interface DataMap {
    toc: TocEntry[]
    collapseToc: boolean
  }
}
