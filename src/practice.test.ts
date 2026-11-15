import { describe, it, expect } from 'vitest';
import { createField, line, text, spaces, deleteToLineEnd, deleteBackward, moveRows, moveCaret, redsRemaining } from './state.ts';
import { Vim } from './vim.ts';
import { loadStage, MAX_STAGE_INDEX } from './stages.ts';
import {
  UndoStack,
  snapshot,
  boardKey,
  describeDelete,
  standardKeys,
  vimKeyLabel,
  nextIndex,
  randomBoard,
} from './practice.ts';

const board = () =>
  createField([line(text('red', 'crash()'), spaces(), text('blue', 'main()')), line(text('red', 'leak(buf)'))]);

describe('undo (#43)', () => {
  it('restores the board, caret and selection exactly, one change at a time', () => {
    const field = board();
    const start = snapshot(field);
    const undo = new UndoStack();

    field.caret = { line: 1, col: 0 };
    const afterMove = snapshot(field);
    undo.record(field, () => deleteToLineEnd(field));
    field.caret = { line: 0, col: 3 };
    field.select = { anchor: { line: 0, col: 1 }, head: { line: 0, col: 3 } };
    const afterFirst = snapshot(field);
    undo.record(field, () => deleteBackward(field)); // deletes the selection
    expect(undo.size).toBe(2);

    expect(undo.undo(field)).toBe(true);
    expect(field).toEqual(afterFirst);
    expect(field.lines[1]).toHaveLength(0);
    expect(undo.undo(field)).toBe(true);
    expect(field).toEqual(afterMove);
    expect(boardKey(field)).toBe(boardKey(start));
    expect(undo.undo(field)).toBe(false);
  });

  it('records only changes to the board — moves are not undo steps', () => {
    const field = board();
    const undo = new UndoStack();
    undo.record(field, () => moveCaret(field, field.caret, 0, 'char-right'));
    expect(undo.size).toBe(0);
    undo.record(field, () => moveRows(field, 1)); // a row move changes the layout
    expect(undo.size).toBe(1);
  });

  it('keeps a snapshot safe from later deletes, which mutate rows in place', () => {
    const field = board();
    const undo = new UndoStack();
    undo.record(field, () => deleteToLineEnd(field));
    const reds = redsRemaining(field);
    undo.undo(field);
    const full = redsRemaining(field);
    expect(full).toBeGreaterThan(reds);
    // delete again after the undo, then undo again: the same full board comes back
    undo.record(field, () => deleteToLineEnd(field));
    undo.undo(field);
    expect(redsRemaining(field)).toBe(full);
  });

  it('undoes a Vim delete and a Vim row move', () => {
    const field = loadStage(3);
    const before = boardKey(field);
    const vim = new Vim();
    const undo = new UndoStack();
    for (const k of ['d', 'd']) undo.record(field, () => vim.key(field, k));
    undo.record(field, () => vim.key(field, '<A-j>'));
    expect(undo.size).toBe(2);
    undo.undo(field);
    undo.undo(field);
    expect(boardKey(field)).toBe(before);
  });
});

describe('readout (#43)', () => {
  it('names the chord, or the mistake', () => {
    expect(describeDelete({ red: 14, blue: 0, chord: 'word', cells: [] })).toBe('14 RED · WORD X1.5');
    expect(describeDelete({ red: 3, blue: 2, chord: 'line', cells: [] })).toBe('3 RED + 2 BLUE -- MISTAKE');
    expect(describeDelete({ red: 0, blue: 1, chord: 'char', cells: [] })).toBe('1 BLUE -- MISTAKE');
    expect(describeDelete({ red: 0, blue: 0, chord: 'char', cells: [] })).toBe('NOTHING RED');
  });

  it('spells keys the way they were pressed', () => {
    expect(standardKeys('word-left', false)).toBe('⌥⌫');
    expect(standardKeys('backward', true)).toBe('⌫ ON SELECTION');
    expect(['d', '/', 'f', 'o', 'o', '<CR>'].map(vimKeyLabel).join('')).toBe('d/foo⏎');
    expect(vimKeyLabel('<C-v>')).toBe('^V');
  });
});

describe('practice boards (#43)', () => {
  it('steps through the stages and wraps at both ends', () => {
    expect(nextIndex(0, 1)).toBe(1);
    expect(nextIndex(MAX_STAGE_INDEX, 1)).toBe(0);
    expect(nextIndex(0, -1)).toBe(MAX_STAGE_INDEX);
  });

  it('draws random boards from the generated stages, with a seed no run uses', () => {
    let i = 0;
    const rolls = [0, 0, 0.999999, 0.999999];
    const rand = () => rolls[i++];
    const low = randomBoard(rand);
    const high = randomBoard(rand);
    expect(low.index).toBe(5);
    expect(high.index).toBe(MAX_STAGE_INDEX);
    for (const b of [low, high]) expect(b.seed).toBeGreaterThan(0);
    // and the seed changes the board
    expect(boardKey(loadStage(20, 7))).not.toBe(boardKey(loadStage(20, 0)));
  });
});
