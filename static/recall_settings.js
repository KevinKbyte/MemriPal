// @ts-check
// The opt-in "Grade recall with Spark" setting (MEM-143): off by default, so a recall request carries no grade
// field and no grading call is made. Storage may be disabled or throw; that reads as off.

export const GRADE_SETTING_KEY = "memripal.gradeWithSpark";

/** @param {Pick<Storage, "getItem">} storage @returns {boolean} */
export function gradeWithSpark(storage) {
  try {
    return storage.getItem(GRADE_SETTING_KEY) === "true";
  } catch {
    return false;
  }
}

/** @param {Pick<Storage, "setItem">} storage @param {boolean} on */
export function setGradeWithSpark(storage, on) {
  try {
    storage.setItem(GRADE_SETTING_KEY, on ? "true" : "false");
  } catch {
    // A full or disabled storage keeps the previous setting; the checkbox still reflects this page's choice.
  }
}

/** Own-key prompt text when the notice's key button opens it (byok.showKeyPrompt). */
export const GRADE_KEY_PROMPT = "Add your own Meta key to grade recall with Spark.";

/**
 * Wire #grade-with-spark to the stored setting. localStorage is touched only inside getItem/setItem, where a
 * disabled storage's throw is caught above.
 * @param {Pick<Document, "getElementById"> & { defaultView?: Window | null }} doc
 * @returns {() => boolean} reads the setting now (flow reads it per Start)
 */
export function wireGradeSetting(doc) {
  /** @type {Pick<Storage, "getItem" | "setItem">} */
  const storage = {
    getItem: (k) => /** @type {Window} */ (doc.defaultView).localStorage.getItem(k),
    setItem: (k, v) => /** @type {Window} */ (doc.defaultView).localStorage.setItem(k, v),
  };
  const box = /** @type {HTMLInputElement | null} */ (doc.getElementById("grade-with-spark"));
  if (box) {
    box.checked = gradeWithSpark(storage);
    box.addEventListener("change", () => setGradeWithSpark(storage, box.checked));
  }
  return () => gradeWithSpark(storage);
}
