/** A replica's name. Must be unique across the whole system. */
export type AgentId = string

/**
 * A globally unique identifier for an operation: the agent that made it and
 * that agent's sequence number. Every op consumes one sequence number per
 * character it inserts (or one per delete), so `seq` values are dense.
 */
export type Id = readonly [agent: AgentId, seq: number]

/** Which side of its parent a node hangs off in the Fugue tree. */
export type Side = 'L' | 'R'

/**
 * Inserts a run of characters. The first character is a child of `parent`
 * (null = the root) on `side`. Each following character is the right child of
 * the character before it, which is how sequential typing looks in Fugue, so
 * a typed word costs one op instead of one per keystroke.
 *
 * Character `i` of `text` has id `[id[0], id[1] + i]`.
 */
export interface InsertOp {
  type: 'ins'
  id: Id
  parent: Id | null
  side: Side
  text: string
}

/**
 * Deletes `len` characters whose ids are `[target[0], target[1] + i]`, for
 * i in [0, len). Deleted characters stay in the tree as tombstones. The op
 * consumes `len` sequence numbers, starting at `id`. A run of backspaces or a
 * deleted selection usually covers one id range, so it fits in one op.
 */
export interface DeleteOp {
  type: 'del'
  id: Id
  target: Id
  len: number
}

export type Op = InsertOp | DeleteOp

/**
 * For each agent, how many of its sequence numbers this replica has applied.
 * Because ops from one agent are applied in order, a single number per agent
 * describes everything a replica has seen.
 */
export type VersionVector = Record<AgentId, number>

/** A change to the visible text, for updating an editor after `apply`. */
export type Change =
  | { type: 'insert'; index: number; text: string; agent: AgentId }
  | { type: 'delete'; index: number; length: number }

/** A read-only view of one node of the Fugue tree, used by the inspector. */
export interface NodeView {
  id: Id
  char: string
  deleted: boolean
  parent: Id | null
  side: Side
}

/** A run of visible characters written by one agent. */
export interface Span {
  agent: AgentId
  text: string
}
