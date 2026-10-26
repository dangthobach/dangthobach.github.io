import { pathToRoot } from "../util/path"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"

const PageTitle: QuartzComponent = ({ fileData, cfg, displayClass }: QuartzComponentProps) => {
  const title = cfg?.pageTitle ?? i18n(cfg.locale).propertyDefaults.title
  const baseDir = pathToRoot(fileData.slug!)
  return (
    <h2 class={classNames(displayClass, "page-title")}>
      <a href={baseDir} aria-label={title}>
        <span class="brand-mark" aria-hidden="true">
          DB
        </span>
        <span class="brand-copy">
          <span class="brand-name">{title}</span>
          <span class="brand-subtitle">Engineering research system</span>
        </span>
      </a>
    </h2>
  )
}

PageTitle.css = `
.page-title {
  margin: 0;
  font-family: var(--titleFont);
}

.page-title > a {
  display: flex;
  align-items: center;
  gap: 0.72rem;
  color: var(--dark);
}

.brand-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 2.35rem;
  height: 2.35rem;
  border-radius: 0.72rem;
  color: white;
  background: linear-gradient(145deg, var(--secondary), var(--tertiary));
  box-shadow: 0 7px 18px color-mix(in srgb, var(--secondary) 22%, transparent);
  font-family: var(--codeFont);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.brand-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.brand-name {
  overflow: hidden;
  color: var(--dark);
  font-size: 0.94rem;
  font-weight: 750;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-subtitle {
  margin-top: 0.16rem;
  color: var(--gray);
  font-family: var(--bodyFont);
  font-size: 0.65rem;
  font-weight: 550;
  letter-spacing: 0.02em;
}

@media (max-width: 800px) {
  .brand-copy { display: none; }
  .brand-mark { width: 2rem; height: 2rem; }
}
`

export default (() => PageTitle) satisfies QuartzComponentConstructor
