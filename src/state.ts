/**
 * Field model + caret/selection/delete ops. Implemented in KDA-33.
 * Types are declared here now so other modules can import against them.
 */
export type Color = 'red' | 'blue';

export interface Block {
  color: Color | null; // null = space
}

export type Line = Block[];

export interface Pos {
  line: number;
  col: number;
}

export interface Selection {
  anchor: Pos;
  head: Pos;
}

export interface FieldState {
  lines: Line[];
  caret: Pos;
  select: Selection | null;
}
