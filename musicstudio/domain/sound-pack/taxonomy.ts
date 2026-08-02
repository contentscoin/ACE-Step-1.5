/**
 * The Semantic_Cue taxonomy — 78 cues across 13 interaction categories (Requirement 24).
 *
 * The requirements glossary defines a Semantic_Cue as "상호작용 결과를 뜻으로 지칭하는
 * 사운드 큐 이름" and fixes the counts: 13 categories, 78 cues (24.1), of which 72 are
 * one-shots (24.4) and 6 are loops (24.5, which names them). Requirement 24.2 makes the
 * *name set* an invariant, so this module is the single declaration of it — a pack is
 * complete exactly when its cue names equal `CUE_NAMES`.
 *
 * ### Why the taxonomy is code and not a table
 *
 * For the reason `domain/effects/preset.ts` gives about built-in presets: these 78 names
 * are a product decision, not user data. Nothing may add a 79th at runtime, Requirement
 * 24.2 compares against them for equality, and a row that could be `UPDATE`d is a worse
 * guarantee of that than a constant that cannot. Migration `0014_sound_pack.sql` therefore
 * stores a *reference* to a cue name and checks the count, not the vocabulary — see that
 * file's header.
 *
 * ### The contract document (Requirement 24.19)
 *
 * 24.19 asks that a pack's detail view return, per cue, "큐 이름, 범주 이름, 의도 설명
 * 1건, 오용 경계 1건 이상". So every entry carries an `intent` and at least one
 * `misuseBoundary`, and `cueContract()` assembles them. A misuse boundary is what makes a
 * semantic cue *semantic*: `success` and `complete` are different sounds because they
 * name different events, and without a stated boundary a designer will reach for whichever
 * one they heard first.
 *
 * Source: the taxonomy, its category set and the per-cue default volumes are transcribed
 * from the UI SFX reference implementation the requirements appendix names as their
 * derivation (`requirements.md`'s traceability row for Requirement 24: "UI SFX
 * `README.md`와 `docs/taxonomy.md`"). The intent and misuse sentences are written here.
 *
 * ### Default volume (Requirement 24.11)
 *
 * 24.11 requires the manifest to carry each cue's "기본 음량", so the value has to exist
 * before an export can name it. Every one is in `[0, 1]`, matching design §8.3's
 * `setVolume(v: number) // 0.0~1.0`, and they are *low* — a `typing` cue at 0.07 and a
 * `loading` loop at 0.10 — because a UI sound that competes with the product's own audio
 * is the failure mode these numbers exist to prevent. Loops are quieter than one-shots as
 * a class, which is design §8.3's rule stated as data.
 */

/** Requirement 24.1: the 13 interaction categories, in taxonomy order. */
export const CUE_CATEGORIES = [
  'input',
  'selection',
  'editing',
  'navigation',
  'movement',
  'communication',
  'feedback',
  'progress',
  'loops',
  'media',
  'system',
  'reward',
  'commerce',
] as const;

export type CueCategory = (typeof CUE_CATEGORIES)[number];

/**
 * Requirement 24.5's six loop cues, named by the clause itself.
 *
 * They are exactly the members of the `loops` category, which is why the category and the
 * loop flag never disagree: `isLoopCue` is derived from the category rather than stored
 * twice. `LOOP_CUE_NAMES` is kept as its own constant because 24.5 lists the names and a
 * reader checking the clause should find the list, not a filter expression.
 */
export const LOOP_CUE_NAMES = [
  'loading',
  'processing',
  'recording',
  'connecting',
  'scanning',
  'streaming',
] as const;

export type LoopCueName = (typeof LOOP_CUE_NAMES)[number];

export interface SemanticCue {
  readonly name: string;
  readonly category: CueCategory;
  /** Requirement 24.19: one intent statement. */
  readonly intent: string;
  /** Requirement 24.19: at least one misuse boundary. */
  readonly misuseBoundaries: readonly [string, ...string[]];
  /** Requirement 24.11: the manifest's 기본 음량, in `[0, 1]`. */
  readonly defaultVolume: number;
}

/**
 * The 78 cues, grouped by category and in taxonomy order.
 *
 * The order matters in two places and is therefore fixed rather than incidental: the
 * manifest is printed in it (so two prints of the same pack agree byte for byte, which is
 * Requirement 24.15), and Requirement 24.22's "나중에 생성된 큐" is read off it.
 */
export const SEMANTIC_CUES: readonly SemanticCue[] = [
  // ── input ────────────────────────────────────────────────────────────────────────
  {
    name: 'hover',
    category: 'input',
    intent: 'A fine pointer discovers a sparse, consequential control.',
    misuseBoundaries: [
      'Not on touch interfaces, which have no hover state to report.',
      'Not on every row of a dense list — the sound stops meaning discovery.',
    ],
    defaultVolume: 0.12,
  },
  {
    name: 'press',
    category: 'input',
    intent: 'A pointer or key goes down on a control that should feel physical.',
    misuseBoundaries: ['Not for the outcome of the action; that is `success` or `complete`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'release',
    category: 'input',
    intent: 'A pressed control springs back, especially after a press-and-hold.',
    misuseBoundaries: ['Not as confirmation — releasing a control confirms nothing.'],
    defaultVolume: 0.18,
  },
  {
    name: 'double-click',
    category: 'input',
    intent: 'A rapid secondary activation is recognised as one gesture.',
    misuseBoundaries: ['Not for two unrelated clicks that happened to be close together.'],
    defaultVolume: 0.2,
  },
  {
    name: 'focus',
    category: 'input',
    intent: 'A control becomes ready for keyboard or text input.',
    misuseBoundaries: ['Not for pointer hover, which does not move focus.'],
    defaultVolume: 0.12,
  },
  {
    name: 'long-press',
    category: 'input',
    intent: 'A sustained press reveals a secondary action.',
    misuseBoundaries: ['Not for an ordinary primary activation.'],
    defaultVolume: 0.18,
  },

  // ── selection ────────────────────────────────────────────────────────────────────
  {
    name: 'select',
    category: 'selection',
    intent: 'An item, tab, option or tool enters the active set.',
    misuseBoundaries: ['Not for turning a binary setting on; that is `toggle-on`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'deselect',
    category: 'selection',
    intent: 'An item leaves the active set.',
    misuseBoundaries: ['Not for closing the view the item lived in; that is `close`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'toggle-on',
    category: 'selection',
    intent: 'A binary setting changes from off to on.',
    misuseBoundaries: ['Not for general selection, which does not assert a state.'],
    defaultVolume: 0.2,
  },
  {
    name: 'toggle-off',
    category: 'selection',
    intent: 'A binary setting changes from on to off.',
    misuseBoundaries: ['Not for an error or a refused setting; that is `blocked`.'],
    defaultVolume: 0.18,
  },
  {
    name: 'check',
    category: 'selection',
    intent: 'A checkbox or task item enters its completed state.',
    misuseBoundaries: ['Not for a whole flow finishing; that is `complete`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'uncheck',
    category: 'selection',
    intent: 'A checkbox or task item returns to its incomplete state.',
    misuseBoundaries: ['Not for undoing a content edit; that is `undo`.'],
    defaultVolume: 0.15,
  },

  // ── editing ──────────────────────────────────────────────────────────────────────
  {
    name: 'delete',
    category: 'editing',
    intent: 'A destructive removal has been committed.',
    misuseBoundaries: ['Not for a removable selection still awaiting confirmation.'],
    defaultVolume: 0.22,
  },
  {
    name: 'cancel',
    category: 'editing',
    intent: 'A pending action is abandoned without being applied.',
    misuseBoundaries: ['Not for dismissing an ordinary navigation layer; that is `close`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'undo',
    category: 'editing',
    intent: 'The most recent change is reversed.',
    misuseBoundaries: ['Not for back navigation, which changes place rather than data.'],
    defaultVolume: 0.18,
  },
  {
    name: 'redo',
    category: 'editing',
    intent: 'A reversed change is applied again.',
    misuseBoundaries: ['Not for retrying a failed request; that is `retry`.'],
    defaultVolume: 0.18,
  },
  {
    name: 'copy',
    category: 'editing',
    intent: 'Selected content is placed on the clipboard.',
    misuseBoundaries: ['Not for duplicating an object in place, which changes the document.'],
    defaultVolume: 0.15,
  },
  {
    name: 'paste',
    category: 'editing',
    intent: 'Clipboard content is inserted into the current context.',
    misuseBoundaries: ['Not for uploading or importing a file, which crosses a boundary.'],
    defaultVolume: 0.17,
  },

  // ── navigation ───────────────────────────────────────────────────────────────────
  {
    name: 'open',
    category: 'navigation',
    intent: 'A menu, sheet, panel or detail view appears.',
    misuseBoundaries: ['Not for starting a background process; that is `start`.'],
    defaultVolume: 0.18,
  },
  {
    name: 'close',
    category: 'navigation',
    intent: 'A layer is dismissed or a detail view recedes.',
    misuseBoundaries: ['Not for stopping media; that is `pause` or `stop`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'back',
    category: 'navigation',
    intent: 'Navigation returns to the previous place.',
    misuseBoundaries: ['Not for undoing a data change; that is `undo`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'forward',
    category: 'navigation',
    intent: 'Navigation advances to the next place.',
    misuseBoundaries: ['Not for finishing a multi-step flow; that is `complete`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'expand',
    category: 'navigation',
    intent: 'A collapsed region reveals its detail in place.',
    misuseBoundaries: ['Not for opening a separate navigation layer; that is `open`.'],
    defaultVolume: 0.16,
  },
  {
    name: 'collapse',
    category: 'navigation',
    intent: 'An expanded region returns to its compact state.',
    misuseBoundaries: ['Not for closing the surrounding view; that is `close`.'],
    defaultVolume: 0.15,
  },

  // ── movement ─────────────────────────────────────────────────────────────────────
  {
    name: 'drag-start',
    category: 'movement',
    intent: 'An object lifts from its resting place into a dragged state.',
    misuseBoundaries: ['Not on every pointer move during the drag.'],
    defaultVolume: 0.18,
  },
  {
    name: 'drop',
    category: 'movement',
    intent: 'A dragged object lands in a valid target.',
    misuseBoundaries: ['Not for a rejected drop; that is `invalid-drop`.'],
    defaultVolume: 0.22,
  },
  {
    name: 'snap',
    category: 'movement',
    intent: 'An object locks to a grid, guide or dock.',
    misuseBoundaries: ['Not for general selection, which asserts no alignment.'],
    defaultVolume: 0.2,
  },
  {
    name: 'swipe',
    category: 'movement',
    intent: 'A touch gesture moves content spatially.',
    misuseBoundaries: ['Not for ordinary scrolling, which is continuous rather than a gesture.'],
    defaultVolume: 0.14,
  },
  {
    name: 'reorder',
    category: 'movement',
    intent: 'An item settles into a new position in a sequence.',
    misuseBoundaries: ['Not on every frame of the drag that produced the reorder.'],
    defaultVolume: 0.18,
  },
  {
    name: 'invalid-drop',
    category: 'movement',
    intent: 'A dragged object cannot land in the target under the pointer.',
    misuseBoundaries: ['Not for a general validation failure; that is `error`.'],
    defaultVolume: 0.19,
  },

  // ── communication ────────────────────────────────────────────────────────────────
  {
    name: 'send',
    category: 'communication',
    intent: 'A message or shared object leaves the user.',
    misuseBoundaries: ['Not for an upload finishing; that is `complete`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'receive',
    category: 'communication',
    intent: 'A direct response or object arrives.',
    misuseBoundaries: ['Not on every background sync, which the user did not ask for.'],
    defaultVolume: 0.2,
  },
  {
    name: 'notification',
    category: 'communication',
    intent: 'New, non-urgent information is available.',
    misuseBoundaries: ['Not for warnings or direct mentions, which need more weight.'],
    defaultVolume: 0.2,
  },
  {
    name: 'mention',
    category: 'communication',
    intent: 'The user is addressed directly.',
    misuseBoundaries: ['Not for general activity feeds, which address nobody.'],
    defaultVolume: 0.22,
  },
  {
    name: 'typing',
    category: 'communication',
    intent: 'Brief feedback for one local text-entry keystroke.',
    misuseBoundaries: [
      'Not for a remote typing indicator, which is a state rather than an event.',
      'Not as a sustained loop while someone types; use `processing` for sustained work.',
    ],
    defaultVolume: 0.07,
  },
  {
    name: 'reaction',
    category: 'communication',
    intent: 'A lightweight social response is added.',
    misuseBoundaries: ['Not for a full message notification, which deserves more attention.'],
    defaultVolume: 0.17,
  },

  // ── feedback ─────────────────────────────────────────────────────────────────────
  {
    name: 'success',
    category: 'feedback',
    intent: 'An action finished with the expected result.',
    misuseBoundaries: ['Not for a long multi-step completion; that is `complete`.'],
    defaultVolume: 0.23,
  },
  {
    name: 'error',
    category: 'feedback',
    intent: 'An action failed and needs correction.',
    misuseBoundaries: ['Not for confirming a destructive action; that is `delete`.'],
    defaultVolume: 0.22,
  },
  {
    name: 'warning',
    category: 'feedback',
    intent: 'A consequential state needs review before proceeding.',
    misuseBoundaries: ['Not for routine information; that is `info`.'],
    defaultVolume: 0.22,
  },
  {
    name: 'info',
    category: 'feedback',
    intent: 'A neutral system fact is surfaced.',
    misuseBoundaries: ['Not on every tooltip, which would make the sound noise.'],
    defaultVolume: 0.16,
  },
  {
    name: 'blocked',
    category: 'feedback',
    intent: 'An action cannot continue in the current state.',
    misuseBoundaries: ['Not for a recoverable network failure; that is `error`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'retry',
    category: 'feedback',
    intent: 'A failed action is attempted again.',
    misuseBoundaries: ['Not for the failure itself; that is `error`.'],
    defaultVolume: 0.18,
  },

  // ── progress ─────────────────────────────────────────────────────────────────────
  {
    name: 'start',
    category: 'progress',
    intent: 'A process, recording or session begins.',
    misuseBoundaries: ['Not for opening a view; that is `open`.'],
    defaultVolume: 0.19,
  },
  {
    name: 'stop',
    category: 'progress',
    intent: 'A process, recording or session ends.',
    misuseBoundaries: ['Not for a successful result; that is `success`.'],
    defaultVolume: 0.19,
  },
  {
    name: 'progress-step',
    category: 'progress',
    intent: 'A discrete step advances inside a longer process.',
    misuseBoundaries: ['Not on every percentage update or animation frame.'],
    defaultVolume: 0.12,
  },
  {
    name: 'complete',
    category: 'progress',
    intent: 'A multi-step or long-running process reaches its final state.',
    misuseBoundaries: ['Not on every successful click; that is `success`.'],
    defaultVolume: 0.24,
  },
  {
    name: 'queued',
    category: 'progress',
    intent: 'Work is accepted and waiting to begin.',
    misuseBoundaries: ['Not for work already running; that is `processing`.'],
    defaultVolume: 0.14,
  },
  {
    name: 'checkpoint',
    category: 'progress',
    intent: 'A meaningful stage in a longer process is saved.',
    misuseBoundaries: ['Not on every percentage increment; that is `progress-step` at most.'],
    defaultVolume: 0.18,
  },

  // ── loops (Requirement 24.5) ─────────────────────────────────────────────────────
  {
    name: 'loading',
    category: 'loops',
    intent: 'An interface is fetching or waiting, and the wait is visible.',
    misuseBoundaries: ['Not for long invisible background work, which the user is not watching.'],
    defaultVolume: 0.1,
  },
  {
    name: 'processing',
    category: 'loops',
    intent: 'Sustained generation, rendering or computation is running.',
    misuseBoundaries: ['Not for a single completed operation; that is `complete`.'],
    defaultVolume: 0.08,
  },
  {
    name: 'recording',
    category: 'loops',
    intent: 'Audio or video capture is live.',
    misuseBoundaries: ['Not for the one-shot confirmation that capture began; that is `start`.'],
    defaultVolume: 0.09,
  },
  {
    name: 'connecting',
    category: 'loops',
    intent: 'A device or live session is searching for a connection.',
    misuseBoundaries: ['Not for the connected outcome; that is `connect`.'],
    defaultVolume: 0.09,
  },
  {
    name: 'scanning',
    category: 'loops',
    intent: 'Content or nearby devices are being discovered.',
    misuseBoundaries: ['Not for an indefinite invisible background task.'],
    defaultVolume: 0.07,
  },
  {
    name: 'streaming',
    category: 'loops',
    intent: 'Live data or media continues to flow.',
    misuseBoundaries: ['Not for ordinary local playback; that is `play`.'],
    defaultVolume: 0.07,
  },

  // ── media ────────────────────────────────────────────────────────────────────────
  {
    name: 'play',
    category: 'media',
    intent: 'Media playback begins or resumes.',
    misuseBoundaries: ['Not for starting an unrelated background process; that is `start`.'],
    defaultVolume: 0.18,
  },
  {
    name: 'pause',
    category: 'media',
    intent: 'Media playback pauses at its current position.',
    misuseBoundaries: ['Not for ending playback; that is `stop`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'seek',
    category: 'media',
    intent: 'The playback position moves to a new point.',
    misuseBoundaries: ['Not for ordinary scrolling, which moves the view rather than the time.'],
    defaultVolume: 0.13,
  },
  {
    name: 'volume-change',
    category: 'media',
    intent: 'Playback loudness moves to a new level.',
    misuseBoundaries: ['Not on every key repeat once the level is already at its limit.'],
    defaultVolume: 0.11,
  },
  {
    name: 'skip-next',
    category: 'media',
    intent: 'Playback advances to the next item.',
    misuseBoundaries: ['Not for seeking within the current item; that is `seek`.'],
    defaultVolume: 0.16,
  },
  {
    name: 'skip-previous',
    category: 'media',
    intent: 'Playback returns to the previous item.',
    misuseBoundaries: ['Not for back navigation outside media; that is `back`.'],
    defaultVolume: 0.16,
  },

  // ── system ───────────────────────────────────────────────────────────────────────
  {
    name: 'connect',
    category: 'system',
    intent: 'A device, service or live session becomes available.',
    misuseBoundaries: ['Not for a routine data refresh, which changes no connection.'],
    defaultVolume: 0.2,
  },
  {
    name: 'disconnect',
    category: 'system',
    intent: 'A device, service or live session goes offline.',
    misuseBoundaries: ['Not for an error the user must correct; that is `error`.'],
    defaultVolume: 0.19,
  },
  {
    name: 'lock',
    category: 'system',
    intent: 'Access closes or a protected state engages.',
    misuseBoundaries: ['Not for destructive removal; that is `delete`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'unlock',
    category: 'system',
    intent: 'Access opens or a protected state disengages.',
    misuseBoundaries: ['Not as generic success feedback; that is `success`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'wake',
    category: 'system',
    intent: 'A dormant device or interface becomes active.',
    misuseBoundaries: ['Not for unlocking protected access; that is `unlock`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'sleep',
    category: 'system',
    intent: 'A device or interface enters a dormant state.',
    misuseBoundaries: ['Not for disconnecting from a service; that is `disconnect`.'],
    defaultVolume: 0.15,
  },

  // ── reward ───────────────────────────────────────────────────────────────────────
  {
    name: 'reward',
    category: 'reward',
    intent: 'A small unit of value is awarded.',
    misuseBoundaries: ['Not for a paid transaction; that is `purchase`.'],
    defaultVolume: 0.22,
  },
  {
    name: 'level-up',
    category: 'reward',
    intent: 'Rank, capability or progression increases.',
    misuseBoundaries: ['Not for a routine progress increment; that is `progress-step`.'],
    defaultVolume: 0.25,
  },
  {
    name: 'achievement',
    category: 'reward',
    intent: 'A rare milestone deserves a fuller celebration.',
    misuseBoundaries: ['Not for frequent task completion, which would wear the sound out.'],
    defaultVolume: 0.26,
  },
  {
    name: 'streak',
    category: 'reward',
    intent: 'Repeated participation extends an active streak.',
    misuseBoundaries: ['Not for a single completed task; that is `check`.'],
    defaultVolume: 0.21,
  },
  {
    name: 'badge',
    category: 'reward',
    intent: 'A collectible distinction is awarded.',
    misuseBoundaries: ['Not for a small repeatable unit of value; that is `reward`.'],
    defaultVolume: 0.22,
  },
  {
    name: 'bonus',
    category: 'reward',
    intent: 'An unexpected extra reward is revealed.',
    misuseBoundaries: ['Not for a normal, expected completion; that is `complete`.'],
    defaultVolume: 0.24,
  },

  // ── commerce ─────────────────────────────────────────────────────────────────────
  {
    name: 'add-to-cart',
    category: 'commerce',
    intent: 'An item enters a cart or pending order.',
    misuseBoundaries: ['Not for a completed purchase; that is `purchase`.'],
    defaultVolume: 0.19,
  },
  {
    name: 'remove-from-cart',
    category: 'commerce',
    intent: 'An item leaves a cart or pending order.',
    misuseBoundaries: ['Not for a refund confirmation; that is `refund`.'],
    defaultVolume: 0.17,
  },
  {
    name: 'checkout',
    category: 'commerce',
    intent: 'A cart advances into the payment flow.',
    misuseBoundaries: ['Not for a completed transaction; that is `purchase`.'],
    defaultVolume: 0.2,
  },
  {
    name: 'purchase',
    category: 'commerce',
    intent: 'A paid transaction or value exchange completes.',
    misuseBoundaries: ['Not for adding an item to a cart; that is `add-to-cart`.'],
    defaultVolume: 0.22,
  },
  {
    name: 'coupon',
    category: 'commerce',
    intent: 'A discount or promotional code is accepted.',
    misuseBoundaries: ['Not for a completed payment; that is `purchase`.'],
    defaultVolume: 0.18,
  },
  {
    name: 'refund',
    category: 'commerce',
    intent: 'Value returns after a completed transaction.',
    misuseBoundaries: ['Not for removing an unpaid cart item; that is `remove-from-cart`.'],
    defaultVolume: 0.2,
  },
];

/** Requirement 24.2's subject: the 78 cue names, in taxonomy order. */
export const CUE_NAMES: readonly string[] = SEMANTIC_CUES.map((cue) => cue.name);

/** The same, as a set, for the membership tests Requirements 24.2 and 24.3 need. */
const CUE_NAME_SET: ReadonlySet<string> = new Set(CUE_NAMES);

const CUE_BY_NAME: ReadonlyMap<string, SemanticCue> = new Map(
  SEMANTIC_CUES.map((cue) => [cue.name, cue]),
);

export function isCueName(value: unknown): boolean {
  return typeof value === 'string' && CUE_NAME_SET.has(value);
}

export function isCueCategory(value: unknown): value is CueCategory {
  return typeof value === 'string' && (CUE_CATEGORIES as readonly string[]).includes(value);
}

/** The cue with this name, or `undefined`. Total over `CUE_NAMES` by construction. */
export function cueByName(name: string): SemanticCue | undefined {
  return CUE_BY_NAME.get(name);
}

/**
 * Requirement 24.5: whether this cue is one of the six loop assets.
 *
 * Derived from the category rather than stored on the cue, so the loop flag and the
 * category can never disagree — which matters because Requirement 24.4 applies to the
 * complement of this set and 24.6 applies to this set, and a cue in neither or both would
 * be judged by the wrong rule.
 */
export function isLoopCue(name: string): boolean {
  return CUE_BY_NAME.get(name)?.category === 'loops';
}

export const ONE_SHOT_CUE_NAMES: readonly string[] = CUE_NAMES.filter(
  (name) => !isLoopCue(name),
);

export function cuesInCategory(category: CueCategory): readonly SemanticCue[] {
  return SEMANTIC_CUES.filter((cue) => cue.category === category);
}

/** Requirement 24.19's per-cue contract entry. */
export interface CueContract {
  readonly cueName: string;
  readonly categoryName: CueCategory;
  readonly intent: string;
  readonly misuseBoundaries: readonly string[];
  readonly loop: boolean;
  readonly defaultVolume: number;
}

/** Requirement 24.19: the contract document for all 78 cues, in taxonomy order. */
export function cueContractDocument(): readonly CueContract[] {
  return SEMANTIC_CUES.map((cue) => ({
    cueName: cue.name,
    categoryName: cue.category,
    intent: cue.intent,
    misuseBoundaries: cue.misuseBoundaries,
    loop: cue.category === 'loops',
    defaultVolume: cue.defaultVolume,
  }));
}

/**
 * Requirements 24.2 and 24.3: the names the taxonomy has and this pack does not.
 *
 * Returned in taxonomy order rather than in the order they were noticed, so two
 * incomplete packs missing the same cues report the same list — which is what makes the
 * message 24.3 returns comparable between runs.
 */
export function missingCueNames(present: Iterable<string>): readonly string[] {
  const have = new Set(present);
  return CUE_NAMES.filter((name) => !have.has(name));
}

/** Names in the pack that the taxonomy does not know. Requirement 24.2's other direction. */
export function unknownCueNames(present: Iterable<string>): readonly string[] {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const name of present) {
    if (!CUE_NAME_SET.has(name) && !seen.has(name)) {
      seen.add(name);
      unknown.push(name);
    }
  }
  return unknown;
}
