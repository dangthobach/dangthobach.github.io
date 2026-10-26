import { FullSlug, resolveRelative } from "../util/path"
import { classNames } from "../util/lang"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const destinations = [
  {
    slug: "index" as FullSlug,
    label: "Focus",
    description: "Dashboard & current work",
    icon: "focus",
  },
  {
    slug: "_moc" as FullSlug,
    label: "Knowledge maps",
    description: "Topics, domains & connections",
    icon: "map",
  },
  {
    slug: "JVM-Frameworks-2026" as FullSlug,
    label: "Study tracks",
    description: "Structured learning paths",
    icon: "study",
  },
  {
    slug: "_inbox" as FullSlug,
    label: "Research inbox",
    description: "Capture & distillation queue",
    icon: "inbox",
  },
] as const

const icons = {
  focus: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <path d="m4.9 4.9 2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2" />
    </svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 6 5-3 8 3 5-3v15l-5 3-8-3-5 3Z" />
      <path d="M8 3v15M16 6v15" />
    </svg>
  ),
  study: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 7 9-4 9 4-9 4Z" />
      <path d="M7 9.2V15c3 2.4 7 2.4 10 0V9.2M21 7v6" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h16v16H4Z" />
      <path d="M4 14h4l2 3h4l2-3h4" />
    </svg>
  ),
}

const ResearchNav: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const currentSlug = fileData.slug ?? ("index" as FullSlug)

  return (
    <nav class={classNames(displayClass, "research-nav")} aria-label="Research workspace">
      <div class="research-nav-label">
        <span class="research-nav-pulse" aria-hidden="true" />
        Research workspace
      </div>
      <div class="research-nav-items">
        {destinations.map((destination) => {
          const active =
            destination.slug === "index"
              ? currentSlug === "index"
              : currentSlug === destination.slug || currentSlug.startsWith(`${destination.slug}/`)

          return (
            <a
              href={resolveRelative(currentSlug, destination.slug)}
              class={active ? "research-nav-item active" : "research-nav-item"}
              aria-current={active ? "page" : undefined}
            >
              <span class="research-nav-icon">{icons[destination.icon]}</span>
              <span class="research-nav-copy">
                <strong>{destination.label}</strong>
                <small>{destination.description}</small>
              </span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}

ResearchNav.css = `
.research-nav {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.research-nav-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.5rem;
  color: var(--gray);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.research-nav-pulse {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--tertiary);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--tertiary) 14%, transparent);
}

.research-nav-items {
  display: grid;
  gap: 0.3rem;
}

.research-nav-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
  padding: 0.62rem 0.65rem;
  border: 1px solid transparent;
  border-radius: 0.75rem;
  color: var(--darkgray);
  background: transparent;
  transition: 160ms ease;
}

.research-nav-item:hover {
  color: var(--dark);
  background: var(--surface-subtle);
  border-color: var(--border-soft);
  transform: translateX(2px);
}

.research-nav-item.active {
  color: var(--secondary);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--secondary) 18%, transparent);
}

.research-nav-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 0.58rem;
  color: var(--gray);
  background: var(--surface);
  border: 1px solid var(--border-soft);
}

.research-nav-item.active .research-nav-icon {
  color: var(--secondary);
  border-color: color-mix(in srgb, var(--secondary) 22%, transparent);
}

.research-nav-icon svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.research-nav-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  line-height: 1.2;
}

.research-nav-copy strong {
  color: inherit;
  font-size: 0.82rem;
}

.research-nav-copy small {
  margin-top: 0.16rem;
  overflow: hidden;
  color: var(--gray);
  font-size: 0.68rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 800px) {
  .research-nav { display: none; }
}
`

export default (() => ResearchNav) satisfies QuartzComponentConstructor
