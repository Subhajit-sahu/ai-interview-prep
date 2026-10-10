import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveVapiIdentifiers, startVapiCall } from "@/lib/vapi.sdk";
import type Vapi from "@vapi-ai/web";

describe("resolveVapiIdentifiers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
    delete process.env.NEXT_PUBLIC_VAPI_WORKFLOW_ID;
    delete process.env.NEXT_PUBLIC_VAPI_SQUAD_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns undefined when no environment variables are set", () => {
    const { assistantId, squadId } = resolveVapiIdentifiers();
    expect(assistantId).toBeUndefined();
    expect(squadId).toBeUndefined();
  });

  it("resolves NEXT_PUBLIC_VAPI_ASSISTANT_ID as assistantId", () => {
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID = "asst-12345";
    const { assistantId, squadId } = resolveVapiIdentifiers();
    expect(assistantId).toBe("asst-12345");
    expect(squadId).toBeUndefined();
  });

  it("falls back to NEXT_PUBLIC_VAPI_WORKFLOW_ID when ASSISTANT_ID is missing", () => {
    process.env.NEXT_PUBLIC_VAPI_WORKFLOW_ID = "workflow-asst-67890";
    const { assistantId, squadId } = resolveVapiIdentifiers();
    expect(assistantId).toBe("workflow-asst-67890");
    expect(squadId).toBeUndefined();
  });

  it("prefers NEXT_PUBLIC_VAPI_ASSISTANT_ID over NEXT_PUBLIC_VAPI_WORKFLOW_ID", () => {
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID = "primary-asst";
    process.env.NEXT_PUBLIC_VAPI_WORKFLOW_ID = "fallback-asst";
    const { assistantId } = resolveVapiIdentifiers();
    expect(assistantId).toBe("primary-asst");
  });

  it("resolves NEXT_PUBLIC_VAPI_SQUAD_ID as squadId", () => {
    process.env.NEXT_PUBLIC_VAPI_SQUAD_ID = "squad-99999";
    const { assistantId, squadId } = resolveVapiIdentifiers();
    expect(assistantId).toBeUndefined();
    expect(squadId).toBe("squad-99999");
  });

  it("trims whitespace and treats empty string as undefined", () => {
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID = "   ";
    process.env.NEXT_PUBLIC_VAPI_SQUAD_ID = "   ";
    const { assistantId, squadId } = resolveVapiIdentifiers();
    expect(assistantId).toBeUndefined();
    expect(squadId).toBeUndefined();
  });
});

describe("startVapiCall", () => {
  const originalEnv = process.env;
  let mockVapi: {
    start: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
    delete process.env.NEXT_PUBLIC_VAPI_WORKFLOW_ID;
    delete process.env.NEXT_PUBLIC_VAPI_SQUAD_ID;
    mockVapi = {
      start: vi.fn().mockResolvedValue({ id: "call-1" }),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws clear error when neither assistant nor squad is configured for generate flow", async () => {
    await expect(
      startVapiCall(mockVapi as unknown as Vapi, {
        type: "generate",
        userName: "John Doe",
        userId: "user-123",
      })
    ).rejects.toThrow(
      "Vapi Assistant or Squad ID is missing. Please configure NEXT_PUBLIC_VAPI_ASSISTANT_ID or NEXT_PUBLIC_VAPI_WORKFLOW_ID in your environment variables."
    );

    expect(mockVapi.start).not.toHaveBeenCalled();
  });

  it("calls vapi.start with assistant ID in 1st argument when assistant is configured", async () => {
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID = "asst-abc-123";

    await startVapiCall(mockVapi as unknown as Vapi, {
      type: "generate",
      userName: "Alice Smith",
      userId: "user-456",
    });

    expect(mockVapi.start).toHaveBeenCalledTimes(1);
    expect(mockVapi.start).toHaveBeenCalledWith("asst-abc-123", {
      variableValues: {
        username: "Alice Smith",
        userid: "user-456",
      },
      metadata: {
        userid: "user-456",
      },
    });
  });

  it("calls vapi.start with squad ID in 3rd argument when only squad is configured", async () => {
    process.env.NEXT_PUBLIC_VAPI_SQUAD_ID = "squad-xyz-789";

    await startVapiCall(mockVapi as unknown as Vapi, {
      type: "generate",
      userName: "Bob Builder",
      userId: "user-789",
    });

    expect(mockVapi.start).toHaveBeenCalledTimes(1);
    expect(mockVapi.start).toHaveBeenCalledWith(
      undefined,
      {
        variableValues: {
          username: "Bob Builder",
          userid: "user-789",
        },
        metadata: {
          userid: "user-789",
        },
      },
      "squad-xyz-789"
    );
  });

  it("handles interview mode by passing interviewer DTO and formatted questions", async () => {
    const mockDTO = { name: "Interviewer AI" };

    await startVapiCall(mockVapi as unknown as Vapi, {
      type: "interview",
      questions: ["Question 1", "Question 2"],
      interviewerDTO: mockDTO as never,
    });

    expect(mockVapi.start).toHaveBeenCalledTimes(1);
    expect(mockVapi.start).toHaveBeenCalledWith(mockDTO, {
      variableValues: {
        questions: "- Question 1\n- Question 2",
      },
    });
  });

  it("throws error in interview mode if interviewerDTO is missing", async () => {
    await expect(
      startVapiCall(mockVapi as unknown as Vapi, {
        type: "interview",
        questions: ["Question 1"],
      })
    ).rejects.toThrow("Interviewer configuration is missing.");

    expect(mockVapi.start).not.toHaveBeenCalled();
  });

  it("propagates SDK rejection when vapi.start rejects", async () => {
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID = "asst-valid";
    mockVapi.start.mockRejectedValue(new Error("Network connection failed"));

    await expect(
      startVapiCall(mockVapi as unknown as Vapi, {
        type: "generate",
        userId: "uid-1",
      })
    ).rejects.toThrow("Network connection failed");
  });
});
