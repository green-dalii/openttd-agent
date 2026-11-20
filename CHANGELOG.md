# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **文档边界**（范围以 `AGENTS.md` §9 为唯一权威）：本文件是每个版本**改了什么**的
> 权威记录（面向使用者与回滚）。
> **不收录**：未来计划（→ `ROADMAP.md`）、开发准则（→ `AGENTS.md`）、
> 踩过的坑的复盘（→ `MEMORY.md`；此处只写"改了什么"，不写"我为什么犯错"）。

## [Unreleased]

### Added
- **The dashboard now shows the evidence behind the numbers, not just the verdict.** The History page gained a **capability trend** (delivered or operating profit, per line or per vehicle) on its own chart - one axis at a time, because the units differ and a shared scale would be a lie. The Compare page's normalised table has **two modes**: the model means and the **per-run rows behind them**, so every average can be checked against the runs that produced it. The Live page gained a **"why?" button per line**, which opens the **route diagnosis** - the same server-side reason the agent's `diagnose_route` tool gets, with the facts split into loading end and unloading end, and "not measured" shown as such instead of 0.
- **The dashboard now shows what the last experiments measured.** The History page lists each run's **operating profit per game
day** (the promotion gate's own measure) and its **route count**, and draws the operating-profit trend on its own chart (separate
from the cash chart - the units differ). Every strategy card now shows the **per-game readings** behind its average ("3 games: -1.3,
16.4, 48.9 (mean 21.3)"), so a promotion's evidence is visible, not just its verdict. The Compare page gained the **normalised
readings** table (delivered and operating profit per line and per vehicle, with medians).
- **The benchmark can now answer "how much does one line deliver".** The result axis measured a **total**, and a total's spread is decided by how many
lines a run built - a building strategy, not the model's ability, which is why the matrix could not separate the two models. Four normalised axes are now
measured and paired: delivered and operating profit **per line** and **per vehicle**. A run that built no line is **not comparable** on the per-line axis, so
it is left out there rather than counted as zero; a missing reading stays "not measured".

### Changed
- **The per-decision tool budget was cutting off the agent's actions.** The budget allowed 12 tool calls per decision, chosen to cap a measured
runaway - but a controlled experiment (2 arms x 2 seeds, same model, same horizon) showed it cut the model's **actions**, not its idling: the
blocked calls were `build_freight_route`, `build_bus_route` and `set_route_vehicles`. With 24 calls the blocked calls fell from 11 and 6 to 3 and 1,
operating profit per game day rose from +4.57/+5.06 to **+48.27/+25.49**, and the tokens per delivered unit **halved**. The default is now 24.

### Fixed

- **Retiring a line that is still being built no longer throws an engine error.** The game script read its route registry without
asking whether the job was registered - and Squirrel's tables are strict: reading a key that does not exist throws
`the index '1014' does not exist`. On a real run the agent retired a line that was still under construction, so the
retirement never happened and the model read a meaningless "engine error" instead of the truth. Every write back to the
registry now asks first ("not registered" -> a **named** failure: `retire_building` for a line still under construction,
`retire_unknown` for one that does not exist, and the same for the fleet, cargo and engine writes).

- **A line that works is no longer diagnosed as broken.** The route diagnosis asked the game what a vehicle would carry if it were
refitted to the line's cargo - but the game only answers that for a vehicle **stopped in a depot**, and when it cannot answer it returns
4294967295 (the unsigned/signed conversion in OpenTTD's `res.Succeeded() ? refit_capacity : -1`, PR #15507). Every vehicle on the road
read as that sentinel, so the diagnosis concluded that a **working** freight line "was never refitted to its cargo" and printed
4294967295 as a capacity in the panel. The sentinel is now reported as "not measured", a line whose vehicles carry none of the cargo gets
its **own** named reason instead of being forced into one of the two measurable causes, "no fault found" no longer claims the vehicles can
carry the cargo, and the diagnosis reports **the line it was asked about** (the executor's current job and its slot readings are reported
separately, so another line's addresses can no longer stand in for this one's).

- **The prebuilt scenario builds a route that can be measured.** The harness left the town pair to the game, which picks by population and
often lands on a pair too far apart to finish inside the run's wait budget - so the measurement window never opened and the cell was no
valid measurement. The harness now picks the **nearest** town pair itself and tries the next candidates in distance order, each with its own
attempt budget; the game script honours an explicit pair, drops its cached pathfinder after a failed search (the retry used to raise
"can't execute over an uninitialized path"), and probes 8 directions instead of 4 (a target behind water had no reachable probe at all).
Verified on the real machine (seed 22): the route came up within 15 samples, the window opened, and the run scored delivered=57 over 80
game days.

- **A broken blueprint no longer wastes a run, and never burns 20 minutes.** On some maps the blueprint's road gives up after a retry, so the route
never becomes operable and the measurement window never opens (the harness already called such a run "not a valid measurement"). Such runs are now
excluded with a named reason, and the prebuilt wait is bounded by the run's own wall-clock budget instead of always waiting 20 minutes.

- **The agent is asked again after a slow decision.** The margin that keeps a question from starting too close to the end of the run was
taken from the last decision's own cost in game days - and the world keeps moving while the model thinks. In the benchmark's prebuilt
scenario the model's first decision used 28 tool calls, which ate more than 90 game days; the margin was then larger than the rest of the
run, so the agent was **never asked again** and the game measured one decision plus an empty wait (two of the six benchmark cells had
exactly one decision). The margin is now capped at a month: one slow decision can delay the question, not cancel the rest of the run.

- **A freight line now says which cargo it carries.** The game script rewrote the route's record whenever the fleet changed, a route was
retired or its cargo or engine was changed, and each rewrite wrote back only the few keys that change touched - so the rest were silently
dropped, among them the cargo the line carries: **a freight line had no cargo label at all**, so the per (cargo, receiving industry)
attribution could never match it and the per-line delivery figure stayed empty on a real machine. The records are now updated in place,
and a guard keeps the table from being rewritten wholesale anywhere else.

- **The benchmark matrix can run a real provider.** Every cell gets its own data directory, and the provider configuration (`llm.json`) was not copied into it -
so every cell stopped at the start-up gate with "no provider/model configured" and the matrix failed in seconds. The matrix now copies the settings file
into each cell (0600, it may carry a key) and checks it before the first cell runs.

- **A route's own vehicles and profit are now counted on that route.** The game script counted the vehicles standing at a route's two end
stations - but that list holds the vehicles *serving* a station, so one route's fleet was counted twice (10 vehicles reported as 20) and,
at a shared station, another route's vehicles were counted as well (a route that was never built reported 10 vehicles and 7076 profit
belonging to someone else). The numbers reach the model's context, so the model judged routes on untrue facts. They now come from the
executor's registry - the route's own fleet - and an unknown route simply has no vehicles. A route's profit now matches the company
fleet reading to the cent (-123 vs -41 x 3; -246 before).

### Added

- **The company now has an operating profit of its own.** The engine reports each vehicle's profit "so far this year", so the number drops when the year turns and a sold vehicle takes its history with it. The harness now keeps its own ledger: the first reading is only a baseline, later readings add the difference, a sold vehicle's
  profit stays on the books, and a year turn moves the reference point instead of clearing the total. It is
  **operating profit** (freight revenue minus running cost) - not the net cash flow, which also contains building,
  vehicles and interest - and it says when it is only a **lower bound**. Compare gained an operating-profit axis.
- **A probe can now answer whether the same savegame gives the same run.** `scripts/determinism-probe.ts` copies a map, starts two servers from
it (`-g <savegame>`), sends the same command to both and compares the money trajectories: **two loads produced identical money levels**, so a
counterfactual fork is possible. A script's own state does **not** travel in a savegame, so both fork arms must start from it.
- **The model can now do the economics of a freight line before it spends.** `estimate_route` takes a cargo and two
  industries and answers with the engine's numbers: price per cargo unit over that distance (`GSCargo.GetCargoIncome`),
  and per truck its capacity, price and running cost (`GSEngine.GetCapacity/GetPrice/GetRunningCost`). Every figure
carries its direction - revenue is an **upper** bound, cost a **lower** bound - and the tool does **not** say whether the line pays off.
- **A freight line that looked dead is not dead - and the model can now ask why.** 290 units of coal waited at the loading station and the
run delivered nothing (real machine, seed 4242). It is not broken: the vehicles stop, load 20 tons, unload, and the cargo monitor records
`own_by_industry = [{COAL, 53, 10}]` - the run was too short for a **round trip** (177 tiles each way), the first visit preceding the mine's
first production. The read-only `diagnose_route` tool reports where the vehicles are and what waits at each end; the server names a reason
from the engine's own criteria (unloading end accepts this cargo, loading end's rating zero, stop reachable by road).

- **The full map is now one question away.** The observation carries a **sample** of the industries (the top producers)
and only the cargo types that had production - small, but the model cannot tell "no production" from "not measured".
Two read-only tools (`get_industries`, `get_cargo`) now fetch the whole thing on demand, and the Run page's industry
table has an **expand all** button. Sample and full list come from **one scan**.
- **The server's own vocabulary is now translated too - by id.** The outcome classes, the problem codes, the delivery measures and the knob values are the
**server's** wording, and the server keeps exactly one canonical wording of them. The front end now looks them up **by id** (`outcome.token_cap`,
`problem.no_credential`) and falls back to the server's text when it has no translation. A test checks the table's coverage against the server's own lists.
- **The Chinese interface now covers the text the scripts render too**, and it keeps up with the language. The hints, empty states, legends and labels the
pages draw at runtime - about 440 more strings - are translated. Two timing faults are gone: the translation of newly rendered text was scheduled on
`requestAnimationFrame`, which only runs while the page is painted (in a background tab everything drawn afterwards stayed English, silently), and the
framework started in a microtask - before the language runtime had initialised - so the first paint was in the default language.
- **The dashboard's Chinese interface is now complete for its static copy.** Every visible sentence in the four pages (Run /
Compare / History / Configure) has a Chinese translation - 324 of them, where before 226 silently fell back to English. The
pages also had Chinese text hard-coded in the markup, so the **English** interface showed half-Chinese captions.
- **The freight axis has a paired comparison.** A benchmark comparison now also reports **cargo delivered per game day**
(the game script's cargo monitor, cargo half only - a different measure from the main axis, never added to it).
Passengers are not in it: the monitor does not count them, and a run with no cargo reading is **not measured**, not zero.
- **The freight numbers reach the screen, and a freight line says how much it delivered.** The server had been computing them
for a while - the scorecard splits cargo from passengers, and the attribution knows what each freight line delivered - but
neither was drawn anywhere. The Run page's route table now has a **Delivered** column (how much that line delivered; a
delivery that cannot be attributed to one line says so instead of showing a number, and a line with no reading shows a dash),
a freight route shows its two **industries** rather than two towns, and the Compare page draws the **cargo / passenger**
split on the Result axis, with the server's own wording of what the split measures. The per-line figure was always a
**derived** number (the engine does not record which vehicle delivered what where), and there was nothing to derive it from:
the script reported cargo totals but dropped the destination, and the route table did not say which industries a line served.
The script now also reports the **per (cargo, receiving industry)** and the **two industry ids of every freight line**, and
the harness attributes each delivery to the one line that serves that cargo at that industry; when several of our lines share
it the delivery is **not split** but reported as unattributable with the reason, and when no line of ours serves it, it is
reported separately rather than dropped. The decision ledger had one shape ("two towns"), so a freight line could arrive as
`null/null` - and those sentences are injected into the model's context: passenger and freight routes are now **two explicit
record kinds**, and the injected sentence says what the line really is, including how much it delivered and that the figure
is derived. Real machine (seed 4242, a coal line 28 -> 53): 160 tonnes attributed to that line, and no fact has a null end.
- **The paired comparison now answers on every axis.** It used to compute exactly one metric - cargo
+ passengers delivered per game day - so the efficiency axis (delivered per 1M tokens) and the
stability axis (share of tool calls that failed) had **no paired interval at all**. That is how "the
efficiency axis looks separable" could sit in a plan for a whole benchmark round without ever being
a verdict. The comparison is now a function of the axis; the registry of comparable metrics owns the
wording (what is counted, in what unit, which way is better) so report and page cannot drift apart;
the report and the Compare page list **every** axis with its verdict, its n and its interval. Growth
stays out on purpose (its metric is a slope across runs) and a pair with a missing reading on one side
is dropped, not counted as a zero difference. The verdict states a **direction**, which on the
efficiency axis is the *worse* one - so the server also says **which model came out better**.
- **Freight deliveries are measured now, and a freight line can be built.** The game script reports
what *this company* delivered, per cargo, with the engine's own cargo monitor (one axis, accumulated
on our side because the monitor hands out the delta and resets, every gap reported - a total with a
gap is a **lower bound**), and the model can now order a **freight line**:
`build_freight_route(cargo, from_industry, to_industry)` - the model picks the cargo and the two
industries; the scaffold finds the station sites by the engine's own rules, lays the road, builds the
depot, buys and refits the truck and starts it. Real machine (seed 4242): coal mine 28 -> power
station 53, **5 tonnes delivered**. A station that does not accept a cargo still receives it from the
industry (that is its *rating*), but a vehicle **cannot unload** where the cargo is not accepted, so the
unloading site must accept it. A refused command now reaches the model.
- **The model can now ask the game a question and get the answer.** The observation surface is a **periodic sample**: it says what the world looks like right now,
  never what *its own vehicle* is doing, how much it carries or what it earned. Two read-only tools close that gap: `inspect_vehicle` (name, location, type, engine,
  age, speed, load, profit this year) and `inspect_town` (name, population, houses, location, growth rate). The channel is the admin port's gameScript **with an
  answer**: the client injects an id, the GS replies `{kind:"answer", id, ok, data}`, and the two are matched by id; when there is no answer the tool says it could not
  ask.
- **A decision now has a result on the world's side.** "The executor says it built the line" is not a result; "the first
vehicle reached the station" is. The join is the **vehicle id**: the executor's route statistics report the line's
`vehiclesIds`, the pushed events report the vehicle, and the two together make "the route decision 3 ordered had its
first vehicle arrive on 1950-03-01" a fact that can be booked - it lands in the route ledger and, from there, in the
cross-run memory. An event about a vehicle we do not know is **not attributed** (attribution must not be guessed).

- **The model can finally see what the game pushes at it.** The engine pushes events to the GameScript (a vehicle was lost, the first vehicle reached a station, an
  industry opened) - and our Bridge GS **drained them and threw them away**: only the admin-port event was handled, so a model could never see "my bus arrived" unless
  it happened to look at exactly the right moment. The GS now maps the engine's event types onto a **closed vocabulary** (the seven kinds are listed in SPEC §10.78),
  the world state keeps them in order (bounded to 50), and the projection carries them - so `observe()` and every decision context show what happened. Real machine
  (real model, seed 4242): the first vehicle reaching each station arrived twice. Two Squirrel traps came with it (MEMORY D95): a **class member must be declared**
  before it is assigned, and **reading a missing key throws**.

- **A comparison only compares one question.** Runs that answered a **different** question - a different scaffold, a
different observation surface, a different slice of the world - are no longer mixed into one table. The server groups
the metric rows by the manifest's own fields (scaffold + observation shape + observation policy), the page offers the
groups, and the numbers below belong to **one** group; the other groups are counted, not dropped.

- **The model can finally see its financing, and it knows why its balance moves.** The company facts already carried the
loan, but not how much more could be borrowed - and the **interest rate is not exposed by the engine at all**, so that one
stays "not measured" rather than a guess. The Bridge GS now reads the company's loan ceiling (it has to enter company mode to
do it) and reports it, so the projection carries `financing { loanCeiling, loanInterval }` (real machine: 300000 / 10000).

- **The model can finally see every town, and the dashboard knows which slice it saw.** The Bridge GS reported the ten
biggest towns only, so every other town reached the model as a bare number (`#14 -> #2`) - it could not even name the
place it was routing to. The GS now reports **every** town with its name (real machine: all 26 towns, with names, in
`observe()`). And because "all 26 towns" and "the ten biggest" are **different questions** even when the facts have the
same shape, the GS now **states its own policy** (`towns=all;industries=top12`) and that statement lands in the manifest
- so Compare can say "these runs did not answer the same question" instead of quietly comparing them.

- **The observation surface now has a fingerprint of its own.** Two runs could share a scaffold and still have seen
different worlds - and nothing said so. The payload fingerprint cannot answer it across runs (it contains the world, so
it differs on every seed - it would cry wolf), so there is now a third fingerprint: the **structure** of the world facts
the model sees (which facts, which types; values and array lengths ignored). It depends on the code only ⇒ it can be
computed **before** a run, both backends record it, and the preview promises it.

- **A comparison can start from the comparison.** The Compare page could only look at runs that already existed: picking the models, the worlds and the caps and then *starting that plan* was impossible. The plan is now computed **server-side** (the page estimates nothing): how many runs it would start, which caps apply, whether the spend is measurable, which model each cell uses - with the same field names the manifest uses, so plan and finished run compare field by field. Launching runs the cells **one after another** (one process, one game port); a failed cell is recorded and the rest still run. The refusals happen before anything starts: a cost cap on a model without a price table, an unknown model, or a plan that collides with a running game.

- **The configuration page is now called what it does.** The page that used to live at `/providers` answers "how is this run configured?", so it is now at `/configure`; the old URL redirects (and the older `/llm` alias still resolves).
- **The score now says what it actually counts.** The delivery counter the harness reads is OpenTTD's *per-cargo-type* array
summed up - and OpenTTD keeps passengers in that same array, so the number has always counted **cargo and passengers**, not
tonnes of freight. The scorecard, the benchmark report, the History page and the model-facing system prompt all said "cargo",
which was untrue. The wording now comes from one place on the server (`DELIVERED_MEASURE`), and the page copies it.

- **The dashboard speaks two languages now.** A switch in the header flips the whole interface between English and Chinese, and the choice is remembered. The English text stays where it always was (the translation table is keyed by it, the gettext way), so there is no second copy to keep in sync, and a guard test fails the build when a translation no longer matches its source. Raw evidence stays raw (the JSON in the agent steps is not translated) and so does the server's own vocabulary.

- **A run can now explain itself.** The run's detail shows the **full manifest**: the same world (seed + game version), the same scaffold (scaffold / payload-shape hashes), and whether the run was capped (token / cost limit). When the provider answered with a different model than the one requested - a substituting gateway - that is flagged instead of hidden. Hashes are shown short, copied in full.

- **The runs can be grouped** by model, seed or backend. The keys come from the ledger, because "which model" has two sources - requested and served - and a guessing page would disagree.

- **The navigation follows the four questions now**: Run / Compare / History / Configure. The "Evolution" page was renamed **Memory** and moved into History, because it manages what the agent *remembers*, not "evolution"; `/evolution` redirects to `/sessions#memory`.

- **Every run now says what kind of run it was.** The backend could already name ten outcomes, but the pages showed a fraction of them - and the most actionable one ("every tool call was refused" - the signal that a model is flailing) was invisible. The vocabulary is now **closed** (ten classes, no more, no less) and its names and meanings come from the server, so History shows each run's class and Compare shows how many runs of each class a model has. A run whose readings are missing reads "unknown" - not "nothing happened".
- **Errors carry a code instead of a sentence.** A failed model-list refresh, a rejected key, a missing credential, an unknown model: each now arrives as `{code, message, hint}`, and **each code has exactly one canonical hint**. The refresh endpoint's status says whose fault it is: 400 when the request cannot be honored (no key), 502 when the provider upstream failed. Pages render by code and never reverse-engineer intent from the wording; a guard keeps it that way.
- **A Compare page.** It answers "how do these models compare on the same worlds": one row per model across the four axes (result, efficiency, reliability, growth), the excluded runs counted **by reason**, and - once two models are picked - the paired verdict with its interval or the reason it cannot be decided. Every run in the list drills through to that run in History.
  The numbers are the server's: the four axes come from the scorecard, the paired verdict from the paired comparison, the exclusion reasons from the existing enum. The page computes nothing and judges nothing; a missing reading reads "not measured", and an unpriced model's cost reads "not measured" rather than $0.

- **The Run page now reads as three bands, and one decision is one row.** The page answers "is it
  playing" (health, score, the current goal), then "what just happened" - a **causal timeline**
  where a row is a decision and expanding it shows the four pieces of evidence together: the tools it called, the GS job they ordered (with its phases), and what changed until the next decision. The pieces are joined **by the job id**, not by guessing from timestamps. The newest 20 rows are shown, older ones load on demand, and the diagnostics moved into a collapsed band.

- **The Run page starts with three steps instead of a screen of dashes.** With nothing measured it showed eight "-" and a red "world frozen" tile, which reads as "this is broken" rather than "nothing has started". It now answers the only question an empty page can answer - choose the model, set the limits, start - and keeps the world sections out of the layout until they have something to say.

- **The timeline is a server fact.** `GET /api/sessions/:id/timeline` returns the rows and the page only draws them; a reading the server did not have reads "not measured", never zero. The GS phases are archived with the session, so a finished run can still be explained.

- **The dashboard can start a run, and says what the next run will use.** The run knobs (seed, game days, scenario, memory arm, thinking level, tool budget, token and cost caps, backend) are settable from the Configure page, and `POST /api/run/start` carries them with the run; the rules are the ones the command line already used - the page cannot introduce a second set. A next-run preview (`POST /api/run/preview`) resolves the knobs server-side and shows the values the next run would use; its field names are the manifest's own, so "the preview equals the manifest" is a contract a test can check field by field. An illegal knob is refused with a reason and a hint, before any game process starts.

- **Benchmark mode (D5)**: a matrix planner that gives every cell its own data dir and refuses to run before the comparison is pre-registered, a four-axis scorecard, paired bootstrap comparison, and JSON + Markdown reports (`scripts/bench.ts`).

- **Run manifest**: every run records the served model, backend, thinking level, tool budget, scaffold fingerprint, real payload fingerprint, first-payload shape, game version and spend caps - in `meta.json` **and** the metrics row (SPEC §10.114–§10.115).

- **Named outcomes**: every run ends with a reason (`delivered`, `delivered_nothing`, `no_construction`, `refused`, `paused_by_agent`, `world_frozen`, `wall_clock_cap`, `token_cap`, `cost_cap`, `unknown`), so a zero is never a bare number.

- **Spend caps**: `LLM_TOKEN_LIMIT` / `LLM_COST_LIMIT` (and CLI flags) stop a run at a decision boundary; a cost cap on an unpriced model refuses to start.

- **Second decision backend**: `AGENT_HARNESS=1` drives the same scaffold through pi-agent-core's `AgentHarness` (replayable transcript, retry/fault visibility). Both backends were verified to send byte-identical system prompts and the same tool set.

- **Scaffold knobs**: `--thinking` and `--tool-budget` (recorded as *resolved* values).

- **Score visibility**: the decision context carries the project's own score, deltas keep `null` instead of folding to 0, and past runs' scores are injected (the control arm `--no-memory` disables the injection too).

- **Dashboard**: manifest comparison rows (backend / scaffold / payload), a "Wire" health KPI, industry & cargo panel, towns panel, minimap, chart zoom/pan, run control from the page, per-session archive with savegame location.

- **`capabilities()`**: the agent can ask which actions exist before trying them.

### Fixed
- **The documentation had drifted away from the code.** Several pointers aimed at things that do not exist: a SPEC
section number that was never created (referenced from the source, the game script and two tests), an index table with
leftover counts that broke the table, a probe command quoted with flags the script does not accept, and three documents
still marked "to be reviewed" after they had been implemented. The roadmap now carries only unfinished work, the lesson
index covers every lesson, and the volatile environment facts (binary, ports, credentials, gate) have a single home.
- **The benchmark matrix could not use a real provider, and it could also do nothing at all.** Every cell is its own data directory while
the key lives outside the repository, so a cell had no credentials and failed; `--credentials` now copies the file into each cell (0600,
never printed, checked before the first cell runs). Separately, the script's "do not run on import" check compared paths as strings - under
a symlinked path it **exited silently having done nothing**; it now compares real paths, and a test fails if it goes quiet.
- **A run that stopped at its budget no longer exits 1.** A run that ends because the token cap, the cost cap, the horizon or the wall clock ran
out - or because the construction did not finish - has produced its data, so it is a **result**, not a failure: the exit code is now 0. Real
failures (the game script never came up, the game crashed, the runner threw) still exit 1. The run's *result* is in the manifest's outcome.
- **The language switch did not translate everything, and it did not translate it back.** Three silent faults: a sentence written across two
lines kept its line breaks in the DOM (the lookup key never matched); a sentence broken up by an inline `<code>` was never translated at
all; and switching back to English left the page mixed, because the original text was remembered on the **parent** element.
- **The harness was counting days on a calendar of its own.** The game day came from a **fictional 360-day year** (31
January and 1 February mapped to the same index), so a "250 game day" run was really about 256 **calendar** days, and
the copy lived in six places. The clock is now the **engine's calendar** in one module: the game day is the calendar
day, quarter boundaries are the engine's quarters (1/4/7/10 January), and a route's "income per day" divides by the day
of the year the engine reports. The reading this exposed - that the promotion gate's `income / 365` is a year-to-date
net cash flow and not a per-game-day profit - is written down in SPEC §10.55 / §10.76.
- **The profit reading was the wrong quantity, the readings were never written down, and the gate was reading the wrong
one.** The gate read `income / 365`, but the engine's `income` is the **current year's** net cash flow (it resets on 1
January) and 365 is a year length, not the run's length - so it was never "this run's profit per game day". It is now the
**net cash flow** (`money - loan`, continuous across the year boundary) over the **game days the run actually took**, and the
model sees the same denominator it is scored on. But the gate asks "does this strategy pay", and net cash flow answers "did
the company overspend": while a run is building it is negative by construction, so the gate could never open for a strategy
that includes building. A real run (MiniMax-M3.1-Flash, seed 11, 151 days) measured the gap - net cash flow **-1499.28/game
day** against operating profit **+14.13/game day**, the 1513/day difference being exactly the construction and the vehicles.
The gate now reads **operating profit**; both measures stay on the card and both are shown on the page (net cash flow is the
company's health, operating profit the strategy's quality - showing only one would make the page do the very substitution
that broke the gate), and a card with no operating-profit reading is **not determinable**, not zero. The readings are
**written down** too: the archive used to drop every economy event (BigInt payloads hit `JSON.stringify` and the error was
swallowed), so a finished run could not be re-read offline - the Run page shows the net cash flow, its per-game-day rate, and
whether it reconciled with the engine's own yearly reading. A real run crossing 1 January (seed 4242, 381 days) reconciles
exactly, and `scripts/recompute-profit.ts` recomputes it from the archive alone.
- **A pair could have compared the wrong two runs, and "not applicable" was reported as zero.** The repeat index was counted over
the rows that **had a reading**, so a run with no reading for one metric shifted its partner - the cells are now the **runs**.
Separately, the game script encodes a missing reading as JSON `null` (so the payload shape never changes), but two readers went
through `Number(value)` - and `Number(null)` is `0` - so "this industry does not accept this cargo" became "stockpile: 0 tonnes".
Every raw counter now asks "missing?" first; world-frozen runs and unfinished horizons are named and excluded from comparisons.
- **The decision context swallowed two facts it had already been given.** The financing facts and the pushed events
  were passed into the decision context and then dropped. The readings were in the projection all along.
- **The navigation now reaches every page.** A page URL was a hand-written table in the server's memory, so a page added
after the server started was unreachable ("not found"). The routes are now **derived from the files** in `public/pages/`.

- **The model can finally see the freight world.** A freight line is "which mine, which plant", and the model could see neither: the GS now reports a
**cargo catalogue** (which cargo is freight, which industries produce it, which **accept** it - the engine's own answer), the **position and name of every
industry**, and the cargo each road engine carries. Real machine (seed 4242): the model planned to link "a producer industry to a consumer industry".

- **The cargo monitor was never missing - our own accumulator was broken.** On 2026-11-01 this project concluded that OpenTTD 15.3's Squirrel API has no cargo
  monitor; that conclusion was **wrong**. The API exists (`script_cargomonitor.hpp` carries `@api game`); the empty split was **our** bug: the accumulator wrote into a
  Squirrel table with a key that did not exist yet, Squirrel tables are strict - the write threw, the facts collector died, and the empty result was read as "the API
  returns null". What the engine really does not expose stays unmeasured: **per station / per route**. The research:
`docs/PER-LINE-DELIVERY-FEASIBILITY.md` - **do not change the engine**.

- **Compare now says when the runs did not answer the same question.** The manifest recorded two fingerprints but nothing compared them; runs whose payload shape differs now print the distinct hashes. The observation surface stays out of `scaffoldHash` on purpose: it depends on the world (unknowable before a run, and it would make the hash seed-dependent) and belongs to `payloadShapeHash` - which today is only recorded on the harness backend, so the check is silent rather than wrong for default-backend runs (follow-up tracked in ROADMAP).

- **A strategy card's identity belongs to the code now, not to the model's wording.** The id used to be a hash of a free-text action plus *every* parameter, so a different town id or a rephrased sentence became a new card - which made "verified in 2 games" structurally unreachable. Identity is now the action name (a closed vocabulary that mirrors the tool catalogue) plus three whitelisted parameters; an unknown action is rejected with the list in the error. Its value is a **measured profit rate per game day** (`income / 365`, stamped from the run's own record), not a number the model reports about itself; cards without that reading stay unpromotable rather than being treated as zero.

- **The Configure page leads with what the next run would use**, and an empty selection is a state, not an error. A fresh install
used to show a red `unknown_provider` before a single field was touched: the server now answers with a `needs` marker ("no model
selected yet") instead of a problem, Start is disabled with the reason beside it, and the file paths moved into a folded note.

- **History answers "which run matters" before it shows a single field.** The page is now three bands: four conclusion
KPIs from the ledger (comparable runs, delivered per game day, tokens per decision, spend), a compact run list whose
rows carry the ledger's own outcome class, and - for the selected run - a conclusion head (outcome, delivered, game
days, cash, fleet, tokens, failures) with the evidence folded behind it (outcome, manifest, token breakdown, staged
summaries, event log). A page that used to be ~9,800px of equally-weighted tables is ~2,900px of conclusions, and the
same numbers stop appearing twice: the header keeps run counts, the strip keeps the measured rates.
- **A training chart that is flat at 0 is now a sentence.** A 900x300 plot with one line on the floor carries no information and reads as a rendering failure; when every comparable run delivered 0 the page says so instead of drawing it.
- **Dropped ledger rows are disclosed on History too.** The ledger keeps the newest row per session id; on pre-2026-10-31
data that silently halved the sample. `/api/evolution` now returns the collisions and the page prints how many rows are
missing and which ids, so its "N comparable runs" cannot be read as the whole ledger. When a colliding row belongs to a
different run, the selected run's delivered reading says "not measured" instead of borrowing a stranger's number.
- **Spend reads "unknown" rather than a partial sum** when any comparable run had no price table (the same rule the header already applied, now applied to the conclusion).

- **The Run header stopped lying about elapsed time and the session id.** Both displayed fields the page never wrote, so they read "-" even mid-run; they now come from the server (the telemetry snapshot, or the supervisor's run record) and the elapsed time actually ticks.

- **The Compare page has a chart now, and the model picker sits on top.** The four axes used to be a table and nothing else.
Each axis gets its own chart - one bar per model, scaled against that axis' own maximum, because the axes have different
units and a shared scale would misrepresent them - while the table keeps the exact values. A reading the server did not
measure is an empty dashed slot, never a zero-length bar: "not measured" and "measured: 0" must not look the same. The picker
moved to the top of the page, so asking for a comparison is one click away instead of a scroll down.

- **The metric ledger no longer loses runs to a session-id collision.** Two runs started in the same second on the same seed used to get the *same* session id, and the ledger keeps "newest wins per id", so one of them disappeared without a trace - in the first benchmark matrix that silently swallowed three of six runs (the Compare page showed "1 model(s)"). Session ids now carry a short random suffix, and the ledger *reports* the collisions, so the Compare page says out loud which runs were dropped and that they are in none of the numbers below.

- **The cargo facts are there from the first heartbeat now.** The Bridge GS recomputed its industry / cargo / delivery
facts every 1000 ticks, so the first thousand ticks of every game reported no cargo at all - and the first thing an
agent does is look at the world. The GS now computes them on its first heartbeat, so the very first observation already
answers "what is produced here, and has any of it moved". Verified on a real machine: the first `observe()` of a fresh
game now carries the cargo totals and the industries.

- **The training panel had been reading an endpoint that never existed.** It asked for `/api/metrics` while the ledger has always lived under `/api/evolution` - so the panel showed "no metrics ledger yet" while the ledger was full of runs. A false empty state is worse than no panel: it says your runs were never recorded.

- **The manifest's "served a different model" flag was invisible.** The warning colour was scoped to the list chips, so the detail table showed the substituted model in plain text.
- **The probe mode carried its own copy of the admin client** (148 lines of protocol code next to the real, tested one) - and it used the one-shot connect, the very mistake that made a probe time out for weeks. It uses the real client now: the handshake is bounded and retried, and the duplicated protocol code is gone.

- **The evolution hooks had drifted into two copies.** The runner re-attaches its own hooks when a run starts, and only the server's copy carried the per-row exclusion reason - so the same run could show a different exclusion depending on which path served the page. They are built in one place now, and a guard keeps them there.

- **The timeline did not survive the start of a run.** The runner re-attaches its own session hooks when a run starts, which **replaced** the server's hooks with a narrower copy - so the feature worked on an idle dashboard and vanished the moment a run began. The hooks are now built in one place, and a guard keeps them there.

- **A cost cap the model cannot enforce is now a bad request, not a conflict.** Setting a cost cap on a model without a
price table could never fire, so it was refused before the game started — but the refusal was reported as "409
conflict", which told the user their request collided with a running game. It is now `400` with the structured reason
`unpriced_with_cost_cap`, and the preview refuses it too (a preview must not promise a run that cannot start).

- **The run knobs form renders.** Alpine's `x-for` has to sit on a `<template>`; on a plain element the loop variable is not in
scope for that element's own directives, so the whole form rendered empty while the page looked fine (the errors only appear in
`console.warn`). The knob fields also had two controls sharing one id, so `#knob-toolBudget` resolved to the hidden one.

- **The preview follows the form.** It was fetched once on load, so the panel kept showing the values of the previous knobs while claiming to describe the next run.

- **One resolver for the run configuration.** The view, the save path, the startup gate and the runner now derive the
selection from the same function, so they cannot answer differently. The gate in particular stopped rejecting models the
runner could run: it built its brain without the persisted model overlay, so a model the Providers page had listed was
reported as "unknown model" and no run could start. The view also reports the model's own api/context/limits instead of
the values the settings file happened to carry.

- **A saved run configuration is now the one that runs.** `GET /api/llm` re-reads `llm.json` on every call instead of
re-merging a snapshot taken at process start, so a save is visible without a restart; the `POST` response is the
post-save view; a catalog save stores the model's own `api`/`contextWindow`/`maxTokens` instead of inheriting the
previous selection's; and an unknown model is rejected with `400 {error, problems[]}` without touching the file.
Restoring a persisted live-model overlay no longer requires a credential, so a model the page listed stays selectable
after a restart.

- **The model list never refreshed, and the configuration had two truths.** The list on the Providers page came from the
**bundled pi-ai snapshot** (generated 2026-09-04), and pi-ai's `refresh()` skips static providers, so a model released
later could neither be listed **nor chosen**; the page now has "Refresh from provider", which asks the provider's own
`/models` endpoint and reports failures with the exact URLs and statuses — including "no credential, so the refresh was
skipped", which pi-ai does silently. Models that only the provider knows are marked "live · price unknown" and persisted.
Separately, the view, the save path, the startup gate and the runner now derive the configuration from **one** resolver,
so they cannot answer differently; the gate had been rejecting a run the runner could run, and the view now reports the
model's own api/context/limits instead of whatever the settings file happened to carry.
- **`get_industries` really filters by cargo now.** The tool promised a cargo filter and the game script ignored it, so the model asked for "only COAL" and got the whole map - a promise the world did not keep. The filter runs on the game side, and a cargo label that does not exist in this game is reported as "no such cargo" (with the labels that do exist), not as "0 industries".
- **Several readings that disagreed with themselves**: deltas folded unread readings to zero ("no change" where nothing had been measured), fleet counts
disagreed (route table vs company stats), a partial game-script failure was silent (one bad API call could kill a whole reply), and runs that were stopped
could look like failures - pause attribution, world-frozen runs and unfinished horizons are now named and excluded from comparisons.

- **Charts flickered and grew** (per-frame `devicePixelRatio` multiplication; width→height feedback loop) - fixed and guarded by a time-series smoke check at dpr=2. `--serve` also kept a stale `llm.json`, so Start after saving a provider still said "not configured", and **`test:live` was red on main** (it picked `events.jsonl` as the newest session) and left OpenTTD running when it failed, which disabled 13 preflight tests.

## [0.6.0] 及更早

已发布版本（v0.1.0 – v0.6.0）的完整记录见 **[`docs/archive/CHANGELOG-0.1-0.6.md`](docs/archive/CHANGELOG-0.1-0.6.md)**
（冻结归档：不再维护；本文件只留未发布的变化）。
