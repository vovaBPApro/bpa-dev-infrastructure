export const DECISION_MAX_LINES = 5;
export const DECISION_MAX_CHARS = 600;
export const DECISION_MAX_LABEL_WORDS = 3;

export type DecisionOption = { label: string; value: string };

export type ComposedDecisionRequest = {
  body: string;
  options: DecisionOption[];
};

export function composeDecisionRequest(input: {
  text: string;
  options: DecisionOption[];
  explanations: string[];
}): ComposedDecisionRequest {
  const text = input.text?.trim();
  if (!text) throw new Error('decision text is empty');
  if (!Array.isArray(input.options) || input.options.length === 0)
    throw new Error('decision options are missing');
  if (!Array.isArray(input.explanations))
    throw new Error('decision explanations are missing');
  if (input.options.length !== input.explanations.length) {
    throw new Error(
      `decision option/explanation count mismatch: ${input.options.length} options, ${input.explanations.length} explanations`,
    );
  }

  const labels = new Set<string>();
  const options = input.options.map((option, index) => {
    const label = option?.label?.trim();
    const value = option?.value?.trim();
    if (!label) throw new Error(`decision option ${index + 1} label is empty`);
    if (label.split(/\s+/u).length > DECISION_MAX_LABEL_WORDS) {
      throw new Error(
        `decision option ${index + 1} label exceeds ${DECISION_MAX_LABEL_WORDS} words`,
      );
    }
    if (labels.has(label))
      throw new Error(`decision option ${index + 1} label is not unique`);
    labels.add(label);
    if (!value) throw new Error(`decision option ${index + 1} value is empty`);
    return { label, value };
  });

  const explanationLines = input.explanations.map((explanation, index) => {
    const detail = explanation?.trim();
    if (!detail)
      throw new Error(`decision option ${index + 1} explanation is empty`);
    if (detail.includes('\n'))
      throw new Error(`decision option ${index + 1} explanation must be one line`);
    return `${options[index].label}: ${detail}`;
  });
  const body = [text, ...explanationLines].join('\n');
  const lineCount = body.split('\n').length;
  if (lineCount > DECISION_MAX_LINES)
    throw new Error(
      `decision body exceeds ${DECISION_MAX_LINES} lines (${lineCount})`,
    );
  if (body.length > DECISION_MAX_CHARS)
    throw new Error(
      `decision body exceeds ${DECISION_MAX_CHARS} characters (${body.length})`,
    );
  return { body, options };
}

export function resolveDecisionResponse(
  decisionId: string,
  options: DecisionOption[],
  optionIndex: number,
): { content: string; option: DecisionOption } {
  const option = options[optionIndex];
  if (!option) throw new Error(`decision option index ${optionIndex} is invalid`);
  return {
    content: `decision:${decisionId}=${option.value}`,
    option,
  };
}
