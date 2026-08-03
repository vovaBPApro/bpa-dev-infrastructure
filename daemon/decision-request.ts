export const DECISION_MAX_LINES = 5;
export const DECISION_MAX_CHARS = 600;
export const DECISION_MAX_LABEL_WORDS = 3;

export type DecisionOption = { label: string; value: string };

export type ComposedDecisionRequest = {
  body: string;
  options: DecisionOption[];
};

export type PendingDecision = {
  chat_id: string;
  options: DecisionOption[];
  decision_id: string;
  message_id?: number;
};

export type DecisionButton = { label: string; callbackData: string };

export function validateDecisionId(decisionId: unknown): string {
  if (typeof decisionId !== 'string' || !decisionId.trim())
    throw new Error('decision id is empty');
  const normalized = decisionId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized))
    throw new Error('decision id is malformed');
  return normalized;
}

export function composeDecisionRequest(input: {
  decisionId: string;
  text: string;
  options: DecisionOption[];
  explanations: string[];
}): ComposedDecisionRequest {
  validateDecisionId(input.decisionId);
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
  const values = new Set<string>();
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
    if (values.has(value))
      throw new Error(`decision option ${index + 1} value is not unique`);
    values.add(value);
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
  const normalizedId = validateDecisionId(decisionId);
  const option = options[optionIndex];
  if (!option) throw new Error(`decision option index ${optionIndex} is invalid`);
  return {
    content: `decision:${normalizedId}=${option.value}`,
    option,
  };
}

export async function handleDecisionRequest(input: {
  decisionId: string;
  text: string;
  options: DecisionOption[];
  explanations: string[];
  sid: string;
  chatIds: string[];
  sendMessage: (
    chatId: string,
    body: string,
    buttons: DecisionButton[],
  ) => Promise<{ message_id: number }>;
  onSendError?: (chatId: string, error: unknown) => void;
  pending: Map<string, PendingDecision>;
}): Promise<{ body: string; buttons: DecisionButton[]; sentChatIds: string[] }> {
  const decisionId = validateDecisionId(input.decisionId);
  const composed = composeDecisionRequest({
    decisionId,
    text: input.text,
    options: input.options,
    explanations: input.explanations,
  });
  const buttons = composed.options.map((option, index) => ({
    label: option.label,
    callbackData: `dec:${input.sid}:${index}`,
  }));
  const sentChatIds: string[] = [];
  for (const chatId of input.chatIds) {
    try {
      const sent = await input.sendMessage(chatId, composed.body, buttons);
      input.pending.set(input.sid, {
        chat_id: chatId,
        options: composed.options,
        decision_id: decisionId,
        message_id: sent.message_id,
      });
      sentChatIds.push(chatId);
    } catch (error) {
      input.onSendError?.(chatId, error);
    }
  }
  return { body: composed.body, buttons, sentChatIds };
}

export function handleDecisionCallback(
  pending: Map<string, PendingDecision>,
  sid: string,
  optionIndex: number,
): { content: string; option: DecisionOption; pending: PendingDecision } {
  const entry = pending.get(sid);
  if (!entry) throw new Error('decision expired or already answered');
  const resolved = resolveDecisionResponse(
    entry.decision_id,
    entry.options,
    optionIndex,
  );
  pending.delete(sid);
  return { ...resolved, pending: entry };
}
