import { randomInt } from "node:crypto";
import { DateTime } from "luxon";

export const feedGenerationKey = video => `${video.kind}:${video.id}:${video.activeAssetId}`;
const MIN_UNSEEN_SHUFFLE_GROUP_SIZE = 5;

function shuffle(rows, choose) {
  for (let index = rows.length - 1; index > 0; index--) {
    const other = choose(index + 1);
    [rows[index], rows[other]] = [rows[other], rows[index]];
  }
  return rows;
}

export function orderVideoFeed(candidates, seen, choose = randomInt) {
  const unseenDays = new Map();
  const watched = [];
  for (const video of candidates) {
    const key = feedGenerationKey(video);
    if (seen.has(key)) { watched.push(key); continue; }
    const time = new Date(video.feedAt).getTime();
    const day = Number.isFinite(time)
      ? DateTime.fromMillis(time, { zone: "Africa/Cairo" }).toISODate() : "";
    if (!unseenDays.has(day)) unseenDays.set(day, []);
    unseenDays.get(day).push(key);
  }
  const groups = [];
  let group = [];
  for (const day of [...unseenDays.keys()].sort().reverse()) {
    const rows = unseenDays.get(day);
    // Keep a dense older day from burying a small, fresher group.
    if (rows.length >= MIN_UNSEEN_SHUFFLE_GROUP_SIZE) {
      if (group.length) groups.push(shuffle(group, choose));
      group = [];
      groups.push(shuffle(rows, choose));
      continue;
    }
    group.push(...rows);
    // Sparse catalogs still need variety when each day contains only one video.
    if (group.length >= MIN_UNSEEN_SHUFFLE_GROUP_SIZE) {
      groups.push(shuffle(group, choose));
      group = [];
    }
  }
  return [...groups.flat(), ...shuffle(group, choose), ...shuffle(watched, choose)];
}
