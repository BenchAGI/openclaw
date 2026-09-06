import { html, nothing, type TemplateResult } from "lit";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { BENCH_LINKS } from "../../components/app-sidebar-agent-menu.ts";
import { icons } from "../../components/icons.ts";
import "../../components/openclaw-mascot.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import { i18n, t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/about.css";

export type AboutCommitCopyState = "idle" | "copying" | "copied" | "error";

type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  copyState: AboutCommitCopyState;
  onCopyCommit: () => void;
  aureliusGreeting: boolean;
  onGreetAurelius: () => void;
  /** Bench runtime line this build ships on (e.g. bench-runtime-2026.9.2). */
  runtime?: string | null;
  /** Cell name and signed-in user from the gateway; null hides the row. */
  cell?: { name: string | null; user: string | null } | null;
};

const SHORT_COMMIT_LENGTH = 12;

// Bench links for customers (UI-BRAND-CONTRACT §3), the same set as the
// sidebar identity menu; the GitHub / Discord / X rows of the upstream About
// screen do not ship in the Vault.
const ABOUT_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; label: () => string }> = [
  { href: BENCH_LINKS.website, icon: icons.globe, label: () => t("aboutPage.linkWebsite") },
  { href: BENCH_LINKS.help, icon: icons.messageSquare, label: () => t("aboutPage.linkHelp") },
  { href: BENCH_LINKS.whatsNew, icon: icons.scrollText, label: () => t("aboutPage.linkWhatsNew") },
  { href: BENCH_LINKS.agents, icon: icons.users, label: () => t("aboutPage.linkAgents") },
];

function formatControlUiBuildDate(
  value: string | null,
  locales?: Intl.LocalesArgument,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locales, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function copyButtonLabel(state: AboutCommitCopyState): string {
  if (state === "copying") {
    return t("aboutPage.copyingCommit");
  }
  if (state === "copied") {
    return t("aboutPage.copiedCommit");
  }
  if (state === "error") {
    return t("aboutPage.copyCommitFailed");
  }
  return t("aboutPage.copyCommit");
}

function copyStatus(state: AboutCommitCopyState): string {
  return state === "copied"
    ? t("aboutPage.copiedCommit")
    : state === "error"
      ? t("aboutPage.copyCommitFailed")
      : "";
}

function renderUnavailable() {
  return html`<span class="muted">${t("aboutPage.unavailable")}</span>`;
}

// Always-relative commit age; the exact localized timestamp lives on hover
// (title) so the row stays compact for any artifact age.
function renderCommitAge(commitAt: string | null) {
  if (!commitAt) {
    return nothing;
  }
  const timestamp = Date.parse(commitAt);
  if (!Number.isFinite(timestamp)) {
    return nothing;
  }
  const exact = new Intl.DateTimeFormat(i18n.getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
  return html`
    <time class="about-commit__age" dir="auto" datetime=${commitAt} title=${exact}
      >${formatRelativeTimestamp(timestamp, { fallback: "" })}</time
    >
  `;
}

function renderCommit(props: AboutProps) {
  const commit = props.buildInfo.commit;
  if (!commit) {
    return renderUnavailable();
  }
  const label = copyButtonLabel(props.copyState);
  return html`
    <span class="about-commit">
      <code dir="ltr" title=${commit}>${commit.slice(0, SHORT_COMMIT_LENGTH)}</code>
      ${renderCommitAge(props.buildInfo.commitAt)}
      <openclaw-tooltip .content=${label}>
        <button
          type="button"
          class="about-commit__copy"
          aria-label=${label}
          aria-busy=${props.copyState === "copying" ? "true" : nothing}
          ?disabled=${props.copyState === "copying"}
          @click=${props.onCopyCommit}
        >
          <span aria-hidden="true">${props.copyState === "copied" ? icons.check : icons.copy}</span>
        </button>
      </openclaw-tooltip>
      <span class="sr-only" role="status" aria-live="polite">${copyStatus(props.copyState)}</span>
    </span>
  `;
}

// The same Aurelius animatronic as the chat welcome hero, rendered big.
// The greeting button briefly shifts him into his celebrating pose.
function renderHero(props: AboutProps) {
  return html`
    <section class="about-hero">
      <button
        type="button"
        class="about-hero__aurelius ${
          props.aureliusGreeting ? "about-hero__aurelius--greeting" : ""
        }"
        aria-label=${t("aboutPage.waveHello")}
        @click=${props.onGreetAurelius}
      >
        <openclaw-mascot
          mood=${props.aureliusGreeting ? "celebrating" : "idle"}
          .size=${168}
        ></openclaw-mascot>
      </button>
      <div class="about-hero__name-row">
        <span class="about-hero__glyph" aria-hidden="true">${icons.benchGlyph}</span>
        <h2 class="about-hero__name">${t("aboutPage.productName")}</h2>
      </div>
      <p class="about-hero__tagline">${t("aboutPage.tagline")}</p>
      ${
        props.buildInfo.version
          ? html`<code class="about-hero__version" dir="ltr">v${props.buildInfo.version}</code>`
          : nothing
      }
      <nav class="about-hero__links" aria-label=${t("aboutPage.linksLabel")}>
        ${ABOUT_LINKS.map(
          (link) => html`
            <a
              class="about-hero__link"
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              <span class="about-hero__link-icon" aria-hidden="true">${link.icon}</span>
              <span>${link.label()}</span>
            </a>
          `,
        )}
      </nav>
    </section>
  `;
}

export function renderAbout(props: AboutProps) {
  const buildDate = formatControlUiBuildDate(props.buildInfo.builtAt, i18n.getLocale());
  const buildFacts = html`
    <dl
      class="settings-kv about-build-grid"
      role="group"
      aria-label=${t("aboutPage.artifactDetails")}
    >
      <dt>${t("aboutPage.version")}</dt>
      <dd>
        ${
          props.buildInfo.version
            ? html`<code dir="ltr" title=${props.buildInfo.version}
                >${props.buildInfo.version}</code
              >`
            : renderUnavailable()
        }
      </dd>
      <dt>${t("aboutPage.commit")}</dt>
      <dd>${renderCommit(props)}</dd>
      ${
        props.buildInfo.branch
          ? html`
              <dt>${t("aboutPage.branch")}</dt>
              <dd>
                <code dir="ltr" title=${props.buildInfo.branch}
                  >${props.buildInfo.branch}${props.buildInfo.dirty === true ? "*" : ""}</code
                >
              </dd>
            `
          : nothing
      }
      <dt>${t("aboutPage.built")}</dt>
      <dd>
        ${
          buildDate && props.buildInfo.builtAt
            ? html`<time
                dir="auto"
                datetime=${props.buildInfo.builtAt}
                title=${props.buildInfo.builtAt}
                >${buildDate}</time
              >`
            : renderUnavailable()
        }
      </dd>
      ${
        props.runtime
          ? html`
              <dt>${t("aboutPage.runtime")}</dt>
              <dd><code dir="ltr" title=${props.runtime}>${props.runtime}</code></dd>
            `
          : nothing
      }
      ${
        props.cell
          ? html`
              <dt>${t("aboutPage.cell")}</dt>
              <dd>
                ${
                  props.cell.user
                    ? t("aboutPage.cellSignedIn", {
                        cell: props.cell.name ?? t("aboutPage.cellLocal"),
                        user: props.cell.user,
                      })
                    : (props.cell.name ?? t("aboutPage.cellLocal"))
                }
              </dd>
            `
          : nothing
      }
    </dl>
  `;
  return renderSettingsPage([
    renderHero(props),
    renderSettingsSection(
      { title: t("aboutPage.artifactTitle"), description: t("aboutPage.artifactSubtitle") },
      buildFacts,
    ),
    renderSettingsSection(
      {},
      renderSettingsRow({
        title: t("aboutPage.gatewayVersion"),
        description: t("aboutPage.gatewayVersionHint"),
        control: props.gatewayVersion
          ? renderSettingsValue(
              html`<code dir="ltr" title=${props.gatewayVersion}>${props.gatewayVersion}</code>`,
              { mono: true },
            )
          : renderSettingsValue(t("aboutPage.unavailable")),
      }),
    ),
    html`<p class="about-footer">${t("aboutPage.license")}</p>`,
  ]);
}
