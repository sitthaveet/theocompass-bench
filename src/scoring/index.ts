import { AXES, type Dataset, type Dimensions, type Posture, type Score, type UserResponse } from '../types.js';

export const SCORING_VERSION = 'theocompass-api-v2-preserved-1';
const round = (value: number, places: number): number => Number(value.toFixed(places));
const priorityWeight = (priority: number): number => Math.pow((priority || 5) / 10, 3);
const postureFactor = (posture: Posture): number => ({ affirmed: 1, apathetic: 0.2, hostile: 0.75 })[posture];
// Deliberately preserve the API's /2.5 formula, not the precompute's *2.5/4.
const toleranceAmp = (tolerance: number): number => 0.5 + (4 - tolerance) / 2.5;
const certaintyAmp = (certainty: number): number => 1 + certainty / 3;
const importance = (posture: Posture, c: number, t: number): number => postureFactor(posture) * toleranceAmp(t) * certaintyAmp(c);

function posture(answer: UserResponse): Posture {
  if (!answer.isSilence) return 'affirmed';
  return answer.silenceType === 'hostile' ? 'hostile' : 'apathetic';
}

export function resolveAnswerIds(answer: UserResponse): string[] {
  if (answer.isSilence) return [];
  const raw = answer.answerIds?.length ? answer.answerIds : [answer.answerId];
  const ids = [...new Set(raw.map(id => id.trim()).filter(id => id && id !== 'skipped'))].slice(0, 8);
  return ids.length ? ids : [''];
}

function splitDrag(scores: number[], certainty: number, tolerance: number): number | null {
  const values = scores.filter(Number.isFinite);
  if (!values.length) return null;
  const best = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const factor = values.length > 1 ? ((4 - tolerance) / 4) * (certainty / 3) : 0;
  return best - (best - mean) * factor;
}

/** Pure extraction of /api/calculate. Validation of model responses happens before this boundary. */
export function scoreAnswers(dataset: Dataset, answers: UserResponse[]): Score {
  if (!answers.length) throw new Error('No answers provided');
  const questionMap = new Map(dataset.questions.map(q => [q.id, q]));
  const optionMap = new Map(dataset.questions.flatMap(q => q.options.map(option => [option.id, option] as const)));
  const userProfile = answers.flatMap(answer => {
    const question = questionMap.get(answer.questionId);
    if (!question?.dimensions) return [];
    const relevant = AXES.filter(axis => question.dimensions![axis] >= 50);
    if (!relevant.length) return [];
    const p = posture(answer);
    let c = answer.certainty;
    let t = answer.tolerance;
    if (p === 'apathetic') { c = 0; t = 2; }
    if (p === 'hostile') { c = 3; t = 1; }
    const ids = resolveAnswerIds(answer);
    const views = ids.length ? ids : [''];
    return [{ question, p, c, t, views, relevant, bw: priorityWeight(question.priority), imp: importance(p, c, t) }];
  });
  const matches = dataset.denominations.map(denomination => {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const user of userProfile) {
      const stats = denomination.perQuestion[user.question.id];
      const answered = stats?.answered || false;
      const dp = answered ? stats.posture : 'apathetic';
      const dc = answered ? (stats.C || 0) : 0;
      // The original API treats denomination T=0 as 2. Preserve this versioned quirk.
      const dt = answered ? (stats.T || 2) : 2;
      const effectiveWeight = user.bw * ((user.imp + importance(dp, dc, dt)) / 2);
      const splitCount = answered ? (stats.splitCount || 1) : 1;
      let silenceCase = 0;
      if (user.p !== 'affirmed' && dp !== 'affirmed') silenceCase = 3;
      else if (user.p !== 'affirmed' || dp !== 'affirmed') {
        const silentSide = user.p !== 'affirmed' ? user.p : dp;
        silenceCase = silentSide === 'hostile' ? 2 : 1;
      }
      const cAmp = 1 + (user.c + dc) / 6;
      const tAmp = 0.5 + ((4 - user.t) + (4 - dt)) * 2.5 / 8 + Math.abs(user.t - dt) / 8;
      const posturePenalty = 5 * (Math.abs(user.c - dc) + Math.abs(user.t - dt));
      const rejectionPenalty = silenceCase === 2 ? 10 * (user.imp + importance(dp, dc, dt)) / 2 : 0;
      const selectionScores: number[] = [];
      for (const id of user.views) {
        const branchScores: number[] = [];
        for (let branch = 0; branch < splitCount; branch++) {
          let dimensionSum = 0;
          let dimensionWeight = 0;
          for (const axis of user.relevant) {
            const za = optionMap.get(id)?.scores[axis] ?? 50;
            const zb = stats?.dimensions[axis]?.values[branch] ?? 50;
            let distance = Math.abs(za - zb);
            if (silenceCase === 3) distance = 0;
            else if (silenceCase) distance = 50;
            const totalDistance = distance * cAmp * tAmp + posturePenalty + rejectionPenalty;
            const ceiling = Math.max(distance * 6 + 35, 215);
            const similarity = Math.max(0, Math.min(100, 100 * (1 - totalDistance / ceiling)));
            const weight = user.question.dimensions![axis] / 100 * user.bw;
            dimensionSum += similarity * weight;
            dimensionWeight += weight;
          }
          if (dimensionWeight > 0) branchScores.push(dimensionSum / dimensionWeight);
        }
        const selectionScore = splitDrag(branchScores, dc, dt);
        if (selectionScore !== null) selectionScores.push(selectionScore);
      }
      const questionScore = splitDrag(selectionScores, user.c, user.t);
      if (questionScore !== null) {
        weightedSum += questionScore * effectiveWeight;
        totalWeight += effectiveWeight;
      }
    }
    return { id: denomination.id, name: denomination.name, family: denomination.family || 'Unknown',
      matchPercentage: totalWeight > 0 ? round(weightedSum / totalWeight, 2) : 0 };
  }).sort((a, b) => b.matchPercentage - a.matchPercentage);

  const families = new Map<string, number[]>();
  for (const match of matches) {
    if (match.family === 'Unknown') continue;
    const values = families.get(match.family) || [];
    values.push(match.matchPercentage);
    families.set(match.family, values);
  }
  const familyMatches = [...families].map(([family, values]) => ({ family,
    matchPercentage: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
  })).sort((a, b) => b.matchPercentage - a.matchPercentage);

  const primary = Object.fromEntries(AXES.map(axis => {
    let sum = 0;
    let total = 0;
    for (const answer of answers) {
      const question = questionMap.get(answer.questionId);
      if (!question?.dimensions || question.dimensions[axis] < 50 || answer.isSilence) continue;
      const positions = resolveAnswerIds(answer).flatMap(id => {
        const option = optionMap.get(id);
        // Preserve Number(null) = 0 in the original fingerprint path.
        return option ? [Number(option.scores[axis])] : [];
      });
      if (!positions.length) continue;
      const position = positions.reduce((s, value) => s + value, 0) / positions.length;
      const weight = question.dimensions[axis] / 100 * priorityWeight(question.priority)
        * toleranceAmp(answer.tolerance) * certaintyAmp(answer.certainty);
      sum += position * weight;
      total += weight;
    }
    return [axis, total > 0 ? round(sum / total, 1) : 50];
  })) as Dimensions<number>;

  let toleranceSum = 0;
  let toleranceWeight = 0;
  let certaintySum = 0;
  let certaintyWeight = 0;
  for (const answer of answers) {
    if (answer.isSilence) continue;
    const severity = (1 + answer.certainty) * (1 + Math.pow(Math.abs(answer.tolerance - 2), 1.5));
    toleranceSum += answer.tolerance * severity;
    toleranceWeight += severity;
    const weight = priorityWeight(questionMap.get(answer.questionId)?.priority || 5);
    certaintySum += answer.certainty * weight;
    certaintyWeight += weight;
  }
  return { scoringVersion: SCORING_VERSION, matches, familyMatches, axes: { ...primary,
    tolerance: toleranceWeight > 0 ? round(toleranceSum / toleranceWeight * 25, 1) : 50,
    certainty: certaintyWeight > 0 ? round(certaintySum / certaintyWeight * (100 / 3), 1) : 50,
  } };
}
