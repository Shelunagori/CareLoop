import type { Metadata } from "next";
import Link from "next/link";
import { AuthorityTag, Pipeline, Said, Section, Stage } from "./_parts";

/**
 * The reviewer's surface.
 *
 * STATIC BY CONSTRUCTION. It reads no database, calls no provider and takes no
 * session: everything on it is written here or quoted from the repository. A
 * page whose job is to explain a privacy model has no business fetching
 * somebody's data to do it, and a reviewer opening this must not create an
 * anonymous user or a row.
 *
 * Nothing here is imported by the product, and the product imports nothing
 * from here.
 */
export const metadata: Metadata = {
  title: "CareLoop — engineering review",
  description:
    "An engineering exploration inspired by Olympia: longitudinal conversational memory, deterministic decisions, and exact-text consent before anything reaches a family member.",
};

const REPO = "https://github.com/Shelunagori/CareLoop";

export default function ReviewPage() {
  return (
    <main className="mx-auto w-full max-w-[64rem] px-4 pb-20 sm:px-6">
      <Hero />
      <TryIt />
      <BehindTheScreen />
      <Stack />
      <Authority />
      <Learnings />
      <Boundaries />
      <Diagram />
      <CodeLayout />
      <Closing />
    </main>
  );
}

function Hero() {
  return (
    <header className="pt-14 pb-12 sm:pt-20">
      <p className="text-[0.8rem] font-semibold tracking-[0.12em] text-[var(--color-muted)] uppercase">
        Engineering review
      </p>
      <h1 className="mt-3 text-[2.1rem] leading-tight font-semibold sm:text-[2.6rem]">CareLoop</h1>
      <p className="mt-3 text-[1.2rem] leading-snug text-[var(--color-muted)]">
        An engineering exploration inspired by Olympia.
      </p>

      <div className="mt-7 max-w-[62ch] space-y-4 text-[1.05rem] leading-relaxed">
        <p>
          While exploring Olympia, I became interested in what longitudinal
          conversational memory could enable once a companion becomes proactive
          rather than purely responsive.
        </p>
        <p className="border-l-2 border-[var(--color-accent)] pl-4 text-[var(--color-foreground)]">
          Can a companion notice a meaningful change in someone&rsquo;s
          relationships or routines and help them reconnect &mdash; without
          giving the language model authority over real-world decisions?
        </p>
        <p className="text-[var(--color-muted)]">
          CareLoop is a working answer to that one question. It is a prototype
          built to be inspected: the interesting part is not that it talks, but
          where the boundary sits between what a model may decide and what only
          application code may.
        </p>
      </div>

      <nav aria-label="Review sections" className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 text-[0.95rem] font-medium text-white transition-colors hover:bg-[#35594a]"
        >
          Try the live demo
        </Link>
        <a
          href="#behind"
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-5 text-[0.95rem] font-medium transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          Architecture
        </a>
        <a
          href="#learnings"
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-5 text-[0.95rem] font-medium transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          Engineering decisions
        </a>
        <a
          href={REPO}
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-5 text-[0.95rem] font-medium transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          Source code
        </a>
      </nav>
    </header>
  );
}

function TryIt() {
  const steps = [
    ["Start the demo", "You get your own anonymous session and your own seeded world."],
    ["Ask", "“Who is Simba?” — answered from stored relationships, not from the sentence."],
    ["Say or type", "“I haven’t seen John today.”"],
    ["Read the proposed message", "Word for word. This is the text that would travel."],
    ["Approve it", "An explicit yes. Anything ambiguous is not consent."],
    ["Before any reply, ask", "“Have you heard from him at all?”"],
    ["Open the delivered email", "Locally this is the development inbox; a deployment sends it."],
    ["Answer as John", "A short bounded reply. No account needed."],
    ["Return to CareLoop", "Your own tab, where you left it."],
    ["Ask", "“Any update from John?”"],
  ] as const;

  return (
    <Section
      id="try"
      eyebrow="Two minutes"
      title="Try the flow yourself"
      lead={
        <>
          The whole loop, from a passing remark to a family member&rsquo;s reply
          and back. Step 6 is worth doing deliberately: it is where most
          companions would guess.
        </>
      }
    >
      <ol className="grid gap-3 sm:grid-cols-2">
        {steps.map(([action, detail], index) => (
          <li
            key={action + index}
            className="flex gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[0.8rem] font-semibold text-[var(--color-muted)]">
              {index + 1}
            </span>
            <span>
              <span className="block font-medium">{action}</span>
              <span className="mt-0.5 block text-[0.95rem] leading-relaxed text-[var(--color-muted)]">
                {detail}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-muted)] p-4 text-[0.95rem] leading-relaxed text-[var(--color-muted)]">
        <strong className="font-semibold text-[var(--color-foreground)]">
          George, John and Simba are synthetic demo data.
        </strong>{" "}
        They are rows in a seeded fixture, not names the code knows about. No
        product logic branches on them, and a real deployment would carry
        whatever people and pets its user actually talks about.
      </p>
    </Section>
  );
}

function BehindTheScreen() {
  return (
    <Section
      id="behind"
      eyebrow="The interesting part"
      title="What happens behind the screen"
      lead={
        <>
          Eight stages. Each one names who decided: a language model, or
          application code. <AuthorityTag kind="model" /> reads or writes
          language. <AuthorityTag kind="deterministic" /> decides something real.
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Stage
          letter="A"
          title="Relational memory"
          authority="model"
          seen={
            <>
              <Said who="George">Who is Simba?</Said>
              <p className="mt-3 text-[var(--color-muted)]">
                CareLoop answers from what it already holds about the people and
                pets in his life.
              </p>
            </>
          }
          behind={
            <Pipeline
              steps={[
                "user message",
                "conversation service",
                "entity + relationship resolution",
                "bounded context assembly",
                "Cloudflare Workers AI",
                "conversational reply",
              ]}
            />
          }
          note={
            <>
              John and Simba are structured entities with confirmed
              relationships, so the answer does not depend on keywords in the
              current sentence. Relationships are resolved relationally, in SQL;
              pgvector is used for <em>episodic</em> recall &mdash; things
              George once described &mdash; and not for working out who somebody
              is.
            </>
          }
        />

        <Stage
          letter="B"
          title="Observation ingestion"
          authority="model"
          seen={<Said who="George">I haven&rsquo;t seen John today.</Said>}
          behind={
            <Pipeline
              steps={[
                "conversational reply sent",
                "durable post-turn job",
                "Cloudflare extraction (JSON schema)",
                "structured observation",
                "entity resolution",
                "interaction event",
                "Supabase Postgres",
              ]}
            />
          }
          note={
            <>
              The model translates natural language into a structured
              observation. It does not decide whether anything should happen
              about it. Ingestion runs after the reply, as a durable job, so a
              provider outage costs a memory and never a conversation.
            </>
          }
        />

        <Stage
          letter="C"
          title="Pattern detection"
          authority="deterministic"
          seen={
            <p>
              Nothing. This stage is silent &mdash; it runs whether or not it
              finds anything, and most of the time it finds nothing.
            </p>
          }
          behind={
            <Pipeline
              steps={[
                "interaction history",
                "baseline engine (median + MAD)",
                "explicit absence / cadence evaluation",
                "signal",
                "reconnect opportunity",
              ]}
            />
          }
          note={
            <>
              Pure TypeScript with fixed thresholds, over observable events.
              CareLoop does not infer loneliness, depression, cognitive decline
              or mood. &ldquo;I haven&rsquo;t seen John&rdquo; is an observable
              statement about a week; &ldquo;George is lonely&rdquo; is a claim
              about a person&rsquo;s inner life, and the system is built so it
              cannot be made.
            </>
          }
        />

        <Stage
          letter="D"
          title="Family message draft"
          authority="model"
          seen={
            <p>
              A proposed message appears, attributed to no one yet &mdash;
              nothing has been sent.
            </p>
          }
          behind={
            <Pipeline
              steps={[
                "signal",
                "minimized SharePayload (6 fields)",
                "Cloudflare family renderer",
                "output guard",
                "exact rendered text stored",
              ]}
            />
          }
          note={
            <>
              The renderer never sees George&rsquo;s transcript. Its input type
              has no field that could carry one &mdash; six whitelisted values,
              and nothing else &mdash; so &ldquo;no history in context&rdquo; is
              enforced by the type rather than by remembering to be careful.
            </>
          }
        />

        <Stage
          letter="E"
          title="Exact-text consent"
          authority="deterministic"
          seen={
            <>
              <p className="text-[var(--color-muted)]">
                George reads the message in full and answers.
              </p>
              <p className="mt-3 rounded-xl bg-[var(--color-accent-soft)] px-4 py-3 text-center text-[0.92rem] leading-relaxed font-semibold">
                WHAT GEORGE SEES
                <br />
                <span aria-hidden="true">=</span>
                <span className="sr-only">is identical to</span>
                <br />
                WHAT GEORGE APPROVES
                <br />
                <span aria-hidden="true">=</span>
                <span className="sr-only">is identical to</span>
                <br />
                WHAT JOHN RECEIVES
              </p>
            </>
          }
          behind={
            <Pipeline
              steps={[
                "stored exact message",
                "shown verbatim to George",
                "explicit approval",
                "consent snapshot + exact-text hash",
                "authorized send",
              ]}
            />
          }
          note={
            <>
              After approval the message is never regenerated &mdash; the stored
              bytes are the bytes that travel, and the hash is checked before
              sending. The model has no involvement in changing approved text
              because nothing calls it. Ambiguity is not approval: a hesitant or
              unclear answer leaves the offer on the table.
            </>
          }
        />

        <Stage
          letter="F"
          title="Authorization is not transport"
          authority="deterministic"
          seen={<p>A confirmation. The message is on its way.</p>}
          behind={
            <Pipeline
              steps={[
                "approval",
                "one transaction: create family_request, consume consent, consume opportunity",
                "commit",
                "— network boundary —",
                "Brevo transactional email",
              ]}
            />
          }
          note={
            <>
              A database cannot transact with an email provider, so the
              obligation is committed first and delivery runs against a row that
              already exists. A failure after authorization leaves the request
              retryable and George is never asked to approve the same thing
              twice. The reverse order would risk messaging a real person a
              second time.
            </>
          }
        />

        <Stage
          letter="G"
          title="John's side"
          authority="deterministic"
          seen={
            <>
              <Said who="Email to John">
                A message from Dad via CareLoop &mdash; the approved sentence,
                and a link to reply.
              </Said>
              <p className="mt-3 text-[var(--color-muted)]">
                Two or three buttons. No account, no password, no app.
              </p>
            </>
          }
          behind={
            <Pipeline
              steps={[
                "Brevo email carrying the exact approved bytes",
                "capability link",
                "bounded response (fixed choices)",
                "persisted family_response",
              ]}
            />
          }
          note={
            <>
              The link <em>is</em> the capability: a random token, stored only
              as a hash, expiring after a week. There is no endpoint that can
              return George&rsquo;s history to a family member, so the
              temptation cannot be satisfied later without a deliberate,
              reviewable change.
            </>
          }
        />

        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface-muted)] p-5 sm:p-6">
          <h3 className="text-[1.05rem] font-semibold">What John never receives</h3>
          <ul className="mt-3 grid gap-2 text-[0.97rem] leading-relaxed text-[var(--color-muted)] sm:grid-cols-2">
            {[
              "George's transcript",
              "The memory graph",
              "Any pattern or score",
              "Internal observations",
              "Model reasoning",
              "Anything about George's mood",
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-[var(--color-accent)]">
                  &times;
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <Stage
          letter="H"
          title="Verified closure"
          authority="deterministic"
          seen={
            <>
              <p className="text-[0.8rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
                Update
              </p>
              <p className="mt-2 rounded-xl bg-[var(--color-accent-soft)] px-4 py-3 leading-relaxed">
                John replied that they are planning to visit this weekend.
                <br />
                <br />
                You&rsquo;re welcome. I hope the visit goes well.
              </p>
            </>
          }
          behind={
            <Pipeline
              steps={[
                "persisted family_response",
                "closure fact",
                "deterministic closure sentence",
                "deterministic safe continuation",
                "George",
              ]}
            />
          }
          note={
            <>
              <strong className="font-semibold text-[var(--color-foreground)]">
                On a verified closure turn the conversational model is not
                invoked at all
              </strong>{" "}
              &mdash; not for the sentence stating the reply, and not for the
              warmth that follows it. Whether a family member replied is an
              external-world fact. Both sentences are application-owned, which
              is why the second one is short: it is derived from the verified
              topic and answer, and says nothing it cannot support.
            </>
          }
        />
      </div>
    </Section>
  );
}

function Stack() {
  const rows = [
    ["Next.js 16 + TypeScript", "Web application, server routes, orchestration and UI."],
    [
      "Supabase Postgres",
      "Conversations, entities, relationships, observations, events, baselines, signals, consent, family requests, responses and closures.",
    ],
    ["Supabase Auth", "Anonymous per-reviewer demo identities, isolated from each other by RLS."],
    ["pgvector", "Episode similarity retrieval for long-term memory."],
    [
      "Cloudflare Workers AI",
      "The active provider for all five AI paths: conversation, extraction, family-message rendering, embeddings and transcription.",
    ],
    ["ElevenLabs", "Optional text-to-speech. Without it, everything else still works."],
    ["Brevo", "Transactional family email delivery."],
    ["Vercel", "Deployment, with functions pinned to Singapore (sin1) beside the database."],
    ["Vitest + PGlite", "Core, service and database tests against real Postgres-compatible behaviour."],
  ] as const;

  const models = [
    ["Text", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
    ["Embeddings", "@cf/baai/bge-m3"],
    ["Transcription", "@cf/openai/whisper-large-v3-turbo"],
  ] as const;

  return (
    <Section
      id="stack"
      eyebrow="Stack"
      title="What it is built on, and why"
      lead="Chosen for boring reasons: one database that can do relations and vectors, one AI provider behind ports, and a transport that is honest about what delivery means."
    >
      <dl className="grid gap-3 sm:grid-cols-2">
        {rows.map(([name, role]) => (
          <div
            key={name}
            className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
          >
            <dt className="font-semibold">{name}</dt>
            <dd className="mt-1 text-[0.95rem] leading-relaxed text-[var(--color-muted)]">{role}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <h3 className="text-[1.02rem] font-semibold">Models in use</h3>
        <dl className="mt-3 flex flex-col gap-2">
          {models.map(([role, id]) => (
            <div key={role} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <dt className="min-w-[7rem] text-[0.9rem] text-[var(--color-muted)]">{role}</dt>
              <dd className="font-mono text-[0.85rem] break-all">{id}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[0.92rem] leading-relaxed text-[var(--color-muted)]">
          Embeddings are 1024-dimensional and the column is 1536, so vectors are
          zero-padded rather than migrated &mdash; appending the same zeros to
          both sides of a cosine leaves it exactly unchanged, and vectors from
          two different models are never allowed to share the index.
        </p>
      </div>
    </Section>
  );
}

function Authority() {
  const model = [
    "Understand conversational language",
    "Extract structured observations from speech",
    "Use bounded retrieved context",
    "Produce ordinary conversational prose",
    "Render a family draft from minimized data",
  ];
  const app = [
    "Entity resolution rules",
    "Memory commits",
    "Baselines and thresholds",
    "Signal creation",
    "Reconnect opportunity state",
    "Consent",
    "Outbound authorization",
    "The exact approved bytes",
    "External-world family response state",
    "Verified closure",
  ];

  return (
    <Section
      id="authority"
      eyebrow="The boundary"
      title="Language intelligence is not authority"
      lead="The same split, stated once and then enforced everywhere: models are good at ambiguity, and ambiguity is the wrong tool for anything irreversible."
    >
      <p className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-5 py-4 text-center text-[1.08rem] leading-snug font-semibold sm:text-[1.2rem]">
        The LLM is a sensor and a renderer; it is never the decision-maker.
      </p>

      <div className="mt-7 grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <AuthorityTag kind="model" />
          <h3 className="mt-3 text-[1.08rem] font-semibold">What the model may do</h3>
          <ul className="mt-3 flex flex-col gap-2 text-[0.97rem] leading-relaxed">
            {model.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-[var(--color-muted)]">
                  &diams;
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-surface)] p-5">
          <AuthorityTag kind="deterministic" />
          <h3 className="mt-3 text-[1.08rem] font-semibold">What only the application may do</h3>
          <ul className="mt-3 flex flex-col gap-2 text-[0.97rem] leading-relaxed">
            {app.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="text-[var(--color-accent)]">
                  &diams;
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-6 max-w-[62ch] text-[1.02rem] leading-relaxed text-[var(--color-muted)]">
        Use a probabilistic model where ambiguity is genuinely useful &mdash;
        understanding what someone meant, phrasing something kindly. Use
        deterministic application state wherever an action, a privacy boundary
        or an external-world truth is involved. The value of writing the line
        down is that every later decision has somewhere to be checked against.
      </p>
    </Section>
  );
}

function Learnings() {
  const cases = [
    {
      title: "A reply that had not happened",
      observed:
        "Asked whether a family member had been in touch, the model produced a plausible reply that did not exist. The database was checked afterwards: the request existed, the response table was empty.",
      issue:
        "The turn told the model when a reply HAD arrived and told it nothing when one had not. Silence is what a language model fills in.",
      change:
        "Waiting state became an application fact. A delivered request with no response now puts an explicit “no reply has been recorded” into the turn, derived from rows.",
    },
    {
      title: "A contradiction after a real reply",
      observed:
        "Once a genuine reply arrived, the deterministic update surfaced correctly — and the model's own continuation followed it with “I hope you hear from him soon.”",
      issue:
        "Guarding the output was a prediction about which sentences a model might write. A third failure got through a pattern guard by not being the shape that was predicted.",
      change:
        "Verified closure turns stopped calling the model at all. The class of failure is closed rather than narrowed.",
    },
    {
      title: "A wake word, removed and then earned back",
      observed:
        "A first wake-word attempt was not reliable enough for a dependable product experience, so it was removed and push-to-talk kept. A later attempt — “Hey Nora”, with a server-authoritative expiry date — behaved well enough in a real browser to stand, and is now on by default.",
      issue:
        "Keeping the first one behind a flag would have meant shipping a feature nobody could trust. Shipping the second without a bound would have meant a demo that quietly outlives the licence it runs on.",
      change:
        "Nora ends on a date the server decides rather than the browser, and leaves push-to-talk as the path that always works. It arms itself on load, because a hands-free companion that has to be switched on by hand every visit is one nobody uses — but the server is still asked every time, the browser still decides about the microphone, and turning it off is remembered. A spoken sentence now also sends itself after three seconds unless cancelled, except while a family offer is on screen, where consent stays the person’s own act. Four general correctness fixes the first attempt surfaced were kept either way.",
    },
    {
      title: "A family matter raised in the middle of small talk",
      observed:
        "“How are you doing?” / “It was good, what about you?” produced a reconnect card — and produced effectively the same card again later in the same conversation.",
      issue:
        "Detection and presentation had been separated, but only halfway. An explicit absence was exempted from the pacing rule because the person had opened the subject themselves — true on the turn they say it, and false for the fourteen days the detector keeps re-examining the stored statement. Separately, “has this card already been shown?” was asked of a twenty-message window, so the answer flipped back to “no” once it scrolled out.",
      change:
        "One gate now decides whether the CURRENT turn still supports THIS opportunity: the person named them, or the sitting that raised it is still running, or — for a statistical gap — the conversation is genuinely underway. A refusal costs nothing: the draft stays waiting, unspent, with no cooldown and no duplicate.",
    },
    {
      title: "Asked about Don, answered about John",
      observed:
        "“Don sent me a message today” was answered with a question about John — somebody from memory who had not been mentioned.",
      issue:
        "Extraction runs after the reply, so a name’s first mention can never have a card. The model was handed cards about the people who were active last week and nothing about the person in front of it, and background with nothing to compete with reads as an agenda.",
      change:
        "The turn now says so explicitly when nobody in memory was named, and tells the model to answer what was actually said rather than substitute a name it knows. Don becomes an ordinary entity through the same extraction path as anyone else — with no relationship invented, because none was stated.",
    },
  ] as const;

  return (
    <Section
      id="learnings"
      eyebrow="Engineering decisions"
      title="What live testing changed"
      lead="Each of these came from running the thing for real, not from reading the code. The pattern is the same every time: observe the failure, then move a boundary rather than add an instruction."
    >
      <div className="flex flex-col gap-4">
        {cases.map((item, index) => (
          <article
            key={item.title}
            className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
          >
            <h3 className="text-[1.08rem] font-semibold">
              <span className="text-[var(--color-muted)]">{index + 1}. </span>
              {item.title}
            </h3>
            <dl className="mt-4 flex flex-col gap-3 text-[0.97rem] leading-relaxed">
              {[
                ["Observed", item.observed],
                ["Root issue", item.issue],
                ["Change", item.change],
              ].map(([label, body]) => (
                <div key={label}>
                  <dt className="text-[0.8rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
                    {label}
                  </dt>
                  <dd className="mt-1">{body}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>

      <p className="mt-6 max-w-[62ch] text-[1.02rem] leading-relaxed text-[var(--color-muted)]">
        None of these were fixed by writing a better prompt. An instruction is a
        probability, and the failures that matter here &mdash; telling someone
        their family got in touch when they did not &mdash; are not the kind to
        leave to one.
      </p>
    </Section>
  );
}

function Boundaries() {
  const items = [
    "No medical diagnosis",
    "No loneliness or mood inference",
    "No transcript ever shared with family",
    "Exact-text consent before anything is sent",
    "No automatic or implied approval",
    "No rewriting of an approved message",
    "No plaintext capability token stored, ever",
    "No background microphone",
    "Raw voice audio is transient and never persisted",
    "Family receive only minimized, approved information",
    "Verified external-world state is application-owned",
    "A wellbeing note repeats what the person said, never an assessment of them",
    "No model writes the wellbeing message — it is a fixed sentence",
    "Nobody receives it unless exactly one family contact is configured",
    "Urgent language stands every proactive offer down",
    "Development-seeded people are never named to a person",
  ];

  return (
    <Section
      id="boundaries"
      eyebrow="Boundaries"
      title="Privacy and safety, as constraints rather than settings"
      lead="Each of these is enforced somewhere a reviewer can point at — a type, a transaction, a missing endpoint — rather than by a policy document."
    >
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[0.97rem] leading-relaxed"
          >
            <span aria-hidden="true" className="text-[var(--color-accent)]">
              &#10003;
            </span>
            {item}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Diagram() {
  const flow = [
    { label: "George", detail: "text or push-to-talk", kind: "person" },
    { label: "Next.js conversation layer", detail: "orchestration", kind: "deterministic" },
    { label: "Cloudflare language understanding", detail: "+ Supabase memory retrieval", kind: "model" },
    { label: "Structured observations", detail: "extraction output, validated", kind: "model" },
    { label: "Deterministic pattern engine", detail: "baselines, thresholds", kind: "deterministic" },
    { label: "Reconnect opportunity", detail: "a row, not a hunch", kind: "deterministic" },
    { label: "Exact-text consent", detail: "shown, approved, hashed", kind: "deterministic" },
    { label: "Authorized family request", detail: "one transaction", kind: "deterministic" },
    { label: "Brevo", detail: "transactional email", kind: "transport" },
    { label: "John", detail: "capability link, no account", kind: "person" },
    { label: "Persisted family response", detail: "bounded choice", kind: "deterministic" },
    { label: "Deterministic closure", detail: "no model involved", kind: "deterministic" },
    { label: "George", detail: "the loop closes", kind: "person" },
  ] as const;

  const skin = (kind: (typeof flow)[number]["kind"]) =>
    kind === "model"
      ? "border-[var(--color-line)] bg-[var(--color-surface-muted)]"
      : kind === "deterministic"
        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
        : "border-[var(--color-line)] bg-[var(--color-surface)]";

  const tag = (kind: (typeof flow)[number]["kind"]) =>
    kind === "model"
      ? "Language model"
      : kind === "deterministic"
        ? "Deterministic"
        : kind === "transport"
          ? "Transport"
          : "Person";

  return (
    <Section
      id="diagram"
      eyebrow="End to end"
      title="One pass through the whole system"
      lead="Every step is labelled with who decides it. The shading follows the label; it never carries meaning on its own."
    >
      <ol className="flex flex-col gap-2">
        {flow.map((node, index) => (
          <li key={`${node.label}-${index}`}>
            <div
              className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border px-4 py-3 ${skin(node.kind)}`}
            >
              <span className="font-medium">{node.label}</span>
              <span className="text-[0.92rem] text-[var(--color-muted)]">{node.detail}</span>
              <span className="ml-auto text-[0.8rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
                {tag(node.kind)}
              </span>
            </div>
            {index < flow.length - 1 ? (
              <div aria-hidden="true" className="py-0.5 pl-6 text-[var(--color-muted)]">
                &darr;
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function CodeLayout() {
  const layers = [
    ["app/", "UI and HTTP routes."],
    ["server/services/", "Use-case orchestration — a turn, a send, a closure."],
    ["server/repositories/", "Postgres access and state transitions."],
    ["server/adapters/", "Cloudflare, Brevo, ElevenLabs and other outside things."],
    ["core/", "Pure deterministic domain logic. No I/O, no SDK, no clock."],
  ] as const;

  const ports = ["LlmProvider", "ExtractionProvider", "EmbeddingProvider", "SpeechToTextProvider", "VoiceProvider", "FamilyRenderProvider", "Notifier", "Clock"];

  return (
    <Section
      id="code"
      eyebrow="Source"
      title="How the repository is laid out"
      lead="Dependencies point one way only, and a lint rule fails the build if they stop doing so."
    >
      <ol className="flex flex-col gap-2">
        {layers.map(([dir, role], index) => (
          <li key={dir}>
            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
              <span className="font-mono text-[0.95rem] font-semibold">{dir}</span>
              <span className="mt-1 block text-[0.95rem] leading-relaxed text-[var(--color-muted)]">
                {role}
              </span>
            </div>
            {index < layers.length - 1 ? (
              <div aria-hidden="true" className="py-0.5 pl-6 text-[var(--color-muted)]">
                &darr;
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <h3 className="text-[1.02rem] font-semibold">Provider ports</h3>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-[var(--color-muted)]">
          Every external vendor sits behind an interface, so the domain depends
          on a capability rather than on a company. Moving the whole AI stack
          from one provider to another was a change to one line of the
          composition root plus new adapters &mdash; no route, service or
          domain module was touched.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {ports.map((port) => (
            <li
              key={port}
              className="rounded-lg bg-[var(--color-surface-muted)] px-2.5 py-1 font-mono text-[0.82rem]"
            >
              {port}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Closing() {
  return (
    <Section
      id="closing"
      title="Try the flow yourself"
      lead="The demo seeds its own world, so nothing you do there touches anyone else's."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 text-[0.95rem] font-medium text-white transition-colors hover:bg-[#35594a]"
        >
          Start CareLoop demo
        </Link>
        <a
          href={REPO}
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-5 text-[0.95rem] font-medium transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          View source code
        </a>
        <a
          href="#behind"
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl px-3 text-[0.95rem] font-medium text-[var(--color-muted)] underline underline-offset-4 hover:text-[var(--color-foreground)]"
        >
          Back to architecture
        </a>
      </div>
    </Section>
  );
}
