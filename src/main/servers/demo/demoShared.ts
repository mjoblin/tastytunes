// What the demo streamer and its library share (split out 2026-09-13 with the
// library): the queue's size and playing id and the loose dictionary type. The
// media server's wire shapes are upnpShapes', shared with the tests' fake.

export const QUEUE_LEN = 30;

export const PLAYING_QUEUE_ID = 28;

export type Dict = Record<string, unknown>;
