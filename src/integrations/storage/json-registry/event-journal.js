/** Event journal append/replay helpers for JSON registry runs. */
import { promises as fs } from "node:fs";
import path from "node:path";

import { buildNonTransitionEvent } from "../../../execution-runs/state-machine.js";
import { nonEmptyString } from "../../../shared/primitives.js";
import { appendJsonLine } from "./fs-atomic.js";

/**
 * Reads and parses an events.jsonl journal.
 *
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readEventsFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.trim()) return [];
  return raw.trimEnd().split("\n").map((line) => JSON.parse(line));
}

export async function lastEventSequence(eventsPath) {
  try {
    const events = await readEventsFile(eventsPath);
    return events.reduce((max, event) => Math.max(max, Number.isSafeInteger(event.sequence) ? event.sequence : 0), 0);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function nextSequence(paths, snapshot) {
  const journalSequence = await lastEventSequence(paths.eventsPath);
  const snapshotSequence = Number.isSafeInteger(snapshot?.last_sequence) ? snapshot.last_sequence : 0;
  return Math.max(journalSequence, snapshotSequence) + 1;
}

export async function readEventsByIdempotency(eventsPath, type, idempotencyKey) {
  if (!nonEmptyString(idempotencyKey)) return [];
  const events = await readEventsFile(eventsPath).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return events.filter((event) => event.type === type && event.idempotency_key === idempotencyKey);
}

export async function readArtifactRecordedEventsByPath(eventsPath, artifactPath) {
  if (!nonEmptyString(artifactPath)) return [];
  const events = await readEventsFile(eventsPath).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return events.filter((event) => event.type === "artifact.recorded" && event.evidence?.path === artifactPath);
}

/**
 * Appends a non-transition event to a run journal without rewriting the snapshot.
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {{ type: string, actor?: string, evidence?: Record<string, unknown>, clock?: () => Date, timestamp?: string, idempotencyKey?: string }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function appendRunEvent(runDir, runId, { type, actor = "registry", evidence = {}, clock = () => new Date(), timestamp = "", idempotencyKey = "" } = {}) {
  if (!runDir) throw new Error("runDir is required");
  const eventsPath = path.join(runDir, "events.jsonl");
  const eventTimestamp = nonEmptyString(timestamp) || clock().toISOString();
  const sequence = await lastEventSequence(eventsPath) + 1;
  const event = buildNonTransitionEvent({
    runId,
    sequence,
    timestamp: eventTimestamp,
    type,
    actor,
    evidence,
    idempotencyKey,
  });
  await appendJsonLine(eventsPath, event);
  return event;
}
