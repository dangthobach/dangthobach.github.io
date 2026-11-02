import { FullSlug, resolveRelative } from "../util/path"
import { byDateAndAlphabetical } from "./PageList"
import { Date, getDate } from "./Date"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/featuredResearch.scss"

interface Options {
  limit: number
  title: string
  subtitle: string
  linkToMore: FullSlug
}

const defaultOptions: Options = {
  limit: 3,
  title: "Deep research mới",
  subtitle: "Các phân tích chuyên sâu mới nhất về database, concurrency và distributed systems.",
  linkToMore: "Deep-Research-Articles" as FullSlug,
}

export default ((userOpts?: Partial<Options>) => {
  const FeaturedResearch: QuartzComponent = ({ allFiles, fileData, cfg }: QuartzComponentProps) => {
    const opts = { ...defaultOptions, ...userOpts }
    const pages = allFiles
      .filter((page) => {
        const tags = page.frontmatter?.tags ?? []
        return tags.includes("deep-research") && page.slug !== opts.linkToMore
      })
      .sort(byDateAndAlphabetical(cfg))
      .slice(0, opts.limit)

    if (pages.length === 0) return null

    return (
      <section class="featured-research" aria-labelledby="featured-research-title">
        <div class="featured-research-header">
          <div>
            <p class="featured-research-kicker">Selected analysis</p>
            <h2 id="featured-research-title">{opts.title}</h2>
            <p>{opts.subtitle}</p>
          </div>
          <a
            class="featured-research-more internal"
            href={resolveRelative(fileData.slug!, opts.linkToMore)}
          >
            Xem toàn bộ <span aria-hidden="true">→</span>
          </a>
        </div>

        <div class="featured-research-grid">
          {pages.map((page, index) => {
            const title = page.frontmatter?.title ?? "Untitled research"
            const domain = page.frontmatter?.domain
            const cover = page.frontmatter?.cover
            const href = resolveRelative(fileData.slug!, page.slug!)

            return (
              <a class="featured-research-card internal" href={href}>
                <div class="featured-research-cover">
                  {typeof cover === "string" ? (
                    <img
                      src={resolveRelative(fileData.slug!, cover as FullSlug)}
                      alt=""
                      loading={index === 0 ? "eager" : "lazy"}
                    />
                  ) : (
                    <span aria-hidden="true">DR</span>
                  )}
                </div>
                <div class="featured-research-copy">
                  <div class="featured-research-meta">
                    <span>Deep research</span>
                    {page.dates && <Date date={getDate(cfg, page)!} locale={cfg.locale} />}
                  </div>
                  <h3>{title}</h3>
                  {typeof domain === "string" && <p>{domain.replaceAll("-", " ")}</p>}
                </div>
              </a>
            )
          })}
        </div>
      </section>
    )
  }

  FeaturedResearch.css = style
  return FeaturedResearch
}) satisfies QuartzComponentConstructor
