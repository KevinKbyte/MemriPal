// @ts-check
// The page's one Pal chat actor (MEM-132): flow.js sets it once the route store is wired; pal_bubble.js reads it
// per message, so a bubble mounted before wireApp still reaches the actor.

/** @typedef {{ act: (text: string) => Promise<string | null> | string | null }} ChatActor */

/** @type {ChatActor | null} */
let actor = null;

/** @param {ChatActor | null} next */
export function setActor(next) {
  actor = next;
}

/** @returns {ChatActor | null} */
export function getActor() {
  return actor;
}
