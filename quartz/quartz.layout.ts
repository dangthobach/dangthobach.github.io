import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

const knowledgeExplorer = () =>
  Component.Explorer({
    title: "Knowledge library",
    folderDefaultState: "collapsed",
    folderClickBehavior: "link",
    useSavedState: false,
    filterFn: (node) =>
      !["tags", ".smart-env", "_scripts", "_templates", "_archive", "Notion-Knowledge"].includes(
        node.slugSegment,
      ),
    mapFn: (node) => {
      const labels: Record<string, string> = {
        _moc: "Knowledge Maps",
        _inbox: "Research Inbox",
        concepts: "Core Concepts",
        "JVM-Frameworks-2026": "JVM Frameworks",
        "Performance-System-Programming": "Performance & Systems",
        "Microservices-Patterns": "Microservices Patterns",
        "Database-Patterns": "Database Patterns",
        "Go-Microservices-Mastery": "Go Microservices",
        "Notion-Knowledge": "Reference Library",
      }
      node.displayName = labels[node.slugSegment] ?? node.displayName.replaceAll("-", " ")
    },
    sortFn: (a, b) => {
      const priority = [
        "_moc",
        "_inbox",
        "JVM-Frameworks-2026",
        "Performance-System-Programming",
        "Microservices-Patterns",
        "Database-Patterns",
        "Rust-Zero-To-Hero",
        "Go-Zero-To-Hero",
        "Go-Microservices-Mastery",
        "concepts",
      ]
      const aIndex = priority.indexOf(a.slugSegment)
      const bIndex = priority.indexOf(b.slugSegment)
      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return 1
        if (bIndex === -1) return -1
        return aIndex - bIndex
      }
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
      return a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    },
  })

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {
      "Back to Portfolio": "https://dangthobach.github.io/",
      GitHub: "https://github.com/dangthobach",
    },
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.ArticleTitle(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.ContentMeta(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.TagList(),
      condition: (page) => page.fileData.slug !== "index",
    }),
  ],
  left: [
    Component.PageTitle(),
    Component.ResearchNav(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    knowledgeExplorer(),
  ],
  right: [
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
    Component.Graph({
      localGraph: { depth: 1, showTags: false, focusOnHover: true, scale: 1 },
    }),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.ResearchNav(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    knowledgeExplorer(),
  ],
  right: [Component.RecentNotes({ title: "Recently updated", limit: 5, showTags: false })],
}
