import Vapi from "@vapi-ai/web";
import type { CreateAssistantDTO, AssistantOverrides } from "@vapi-ai/web/dist/api";

const token = process.env.NEXT_PUBLIC_VAPI_WEB_TOKEN || "";
export const vapi = new Vapi(token);

export interface VapiStartOptions {
  type: "generate" | "interview";
  userName?: string;
  userId?: string;
  questions?: string[];
  interviewerDTO?: CreateAssistantDTO;
}

/**
 * Resolves configured Assistant, Workflow, or Squad identifiers.
 * Supports standard Vapi conventions:
 * - NEXT_PUBLIC_VAPI_ASSISTANT_ID or NEXT_PUBLIC_VAPI_WORKFLOW_ID for assistants
 * - NEXT_PUBLIC_VAPI_SQUAD_ID for squads
 */
export function resolveVapiIdentifiers(): {
  assistantId?: string;
  squadId?: string;
} {
  const rawSquadId = process.env.NEXT_PUBLIC_VAPI_SQUAD_ID?.trim();
  const rawAssistantId =
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID?.trim() ||
    process.env.NEXT_PUBLIC_VAPI_WORKFLOW_ID?.trim();

  const squadId = rawSquadId && rawSquadId.length > 0 ? rawSquadId : undefined;
  const assistantId =
    rawAssistantId && rawAssistantId.length > 0 ? rawAssistantId : undefined;

  return { assistantId, squadId };
}

/**
 * Starts a Vapi session with correct argument dispatch and explicit parameter validation:
 * - For assistants: vapi.start(assistantId, overrides)
 * - For squads: vapi.start(undefined, overrides, squadId)
 * - For inline interviewer DTO: vapi.start(interviewerDTO, overrides)
 */
export async function startVapiCall(
  vapiInstance: Vapi,
  options: VapiStartOptions
) {
  if (options.type === "generate") {
    const { assistantId, squadId } = resolveVapiIdentifiers();

    if (!assistantId && !squadId) {
      throw new Error(
        "Vapi Assistant or Squad ID is missing. Please configure NEXT_PUBLIC_VAPI_ASSISTANT_ID or NEXT_PUBLIC_VAPI_WORKFLOW_ID in your environment variables."
      );
    }

    const overrides: AssistantOverrides = {
      variableValues: {
        username: options.userName,
        userid: options.userId,
      },
      metadata: {
        userid: options.userId,
      },
    };

    if (squadId && !assistantId) {
      return await vapiInstance.start(undefined, overrides, squadId);
    }

    return await vapiInstance.start(assistantId, overrides);
  } else {
    let formattedQuestions = "";
    if (options.questions && options.questions.length > 0) {
      formattedQuestions = options.questions
        .map((question) => `- ${question}`)
        .join("\n");
    }

    if (!options.interviewerDTO) {
      throw new Error("Interviewer configuration is missing.");
    }

    return await vapiInstance.start(options.interviewerDTO, {
      variableValues: {
        questions: formattedQuestions,
      },
    });
  }
}
