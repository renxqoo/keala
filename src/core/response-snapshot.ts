/** Serialization metadata belongs to the exact response, never the request. */
const SERIALIZED_TEXT = Symbol("keala.serializedText");
type SnapshotResponse = Response & { [SERIALIZED_TEXT]?: string };
export const serializedTextOf = (response: Response): string | undefined =>
  (response as SnapshotResponse)[SERIALIZED_TEXT];
export const rememberSerializedText = (response: Response, text: string): void => {
  (response as SnapshotResponse)[SERIALIZED_TEXT] = text;
};
