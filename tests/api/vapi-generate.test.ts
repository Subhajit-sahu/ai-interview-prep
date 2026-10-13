import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock firebase admin before importing route
const mockAdd = vi.fn();
const mockDocGet = vi.fn();
const mockGetUser = vi.fn();
const mockVerifyIdToken = vi.fn();

vi.mock("@/firebase/admin", () => ({
  auth: {
    getUser: (...args: unknown[]) => mockGetUser(...args),
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  },
  db: {
    collection: (name: string) => {
      if (name === "interviews") {
        return { add: mockAdd };
      }
      if (name === "users") {
        return {
          doc: (id: string) => ({
            get: () => mockDocGet(id),
          }),
        };
      }
      return {};
    },
  },
}));

vi.mock("@/lib/utils", () => ({
  getRandomInterviewCover: () => "/covers/test-cover.png",
}));

import { POST, GET, safeParseJsonArray } from "@/app/api/vapi/generate/route";

describe("safeParseJsonArray helper", () => {
  it("parses clean JSON array of strings", () => {
    const input = '["Explain React hooks", "What is virtual DOM"]';
    expect(safeParseJsonArray(input)).toEqual([
      "Explain React hooks",
      "What is virtual DOM",
    ]);
  });

  it("extracts JSON array when surrounded by markdown or commentary", () => {
    const input =
      'Here are your questions:\n["Describe event loop in javascript", "Explain react state management"]\nHope this helps!';
    expect(safeParseJsonArray(input)).toEqual([
      "Describe event loop in javascript",
      "Explain react state management",
    ]);
  });

  it("throws when string does not contain an array", () => {
    expect(() => safeParseJsonArray("not an array")).toThrow();
  });
});

describe("Vapi Interview Generation API — Strict Security & Identity Binding", () => {
  const originalEnv = process.env;
  const TEST_WEBHOOK_SECRET = "test-secure-vapi-secret-12345";

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_MODEL: "mistralai/devstral-2512:free",
      VAPI_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    };

    // Default mock behavior for verified test user
    mockGetUser.mockImplementation(async (uid: string) => {
      if (uid === "existing-candidate-uid") {
        return { uid: "existing-candidate-uid", email: "candidate@prepwise.com" };
      }
      throw new Error("User not found in Firebase Auth");
    });

    mockDocGet.mockImplementation(async (uid: string) => {
      if (uid === "existing-candidate-uid") {
        return { exists: true, data: () => ({ name: "Candidate" }) };
      }
      return { exists: false };
    });

    mockAdd.mockResolvedValue({ id: "interview-doc-999" });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  const validPayload = {
    role: "Frontend Developer",
    type: "Technical",
    level: "Senior",
    amount: 3,
    techstack: ["React", "TypeScript"],
    userid: "existing-candidate-uid",
  };

  const createRequest = (body: unknown, headers: Record<string, string> = {}) => {
    return new Request("http://localhost:3000/api/vapi/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  };

  const mockOpenRouterSuccess = (questions: string[]) => {
    const jsonString = JSON.stringify(questions);
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: jsonString,
                reasoning_details: { thoughts: "verified" },
              },
            },
          ],
        }),
      });
    });
  };

  // ---------------- SECURITY REGRESSION TESTS ----------------

  it("Security 1: Request with existing UID but NO webhook secret is strictly REJECTED (401 Unauthorized)", async () => {
    global.fetch = vi.fn();
    // Caller provides a known existing UID, but no x-vapi-secret or Bearer credential
    const req = createRequest(validPayload);
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.error).toContain("webhook credentials");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Security 2: Request with existing UID but WRONG webhook secret is strictly REJECTED (401 Unauthorized)", async () => {
    global.fetch = vi.fn();
    const req = createRequest(validPayload, {
      "x-vapi-secret": "incorrect-secret",
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.error).toContain("webhook credentials");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Security 3: When VAPI_WEBHOOK_SECRET is unconfigured on the server, endpoint FAILS CLOSED (500) and never accepts unauthenticated calls", async () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    global.fetch = vi.fn();

    const req = createRequest(validPayload);
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toContain("VAPI_WEBHOOK_SECRET is not configured");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Security 4: Valid webhook secret with NON-EXISTENT candidate UID is REJECTED (403 Forbidden)", async () => {
    global.fetch = vi.fn();
    const req = createRequest(
      {
        ...validPayload,
        userid: "non-existent-arbitrary-uid",
      },
      {
        "x-vapi-secret": TEST_WEBHOOK_SECRET,
      }
    );
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Candidate does not exist");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Security 5: Valid webhook secret with missing candidate userid is REJECTED (400 Bad Request)", async () => {
    global.fetch = vi.fn();
    const payloadWithoutId = { ...validPayload };
    delete (payloadWithoutId as Record<string, unknown>).userid;

    const req = createRequest(payloadWithoutId, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain("userid");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Security 6: Cryptographic candidate ID token is verified directly via Firebase Admin without requiring webhook secret", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "cryptographically-verified-user" });
    mockOpenRouterSuccess(["Question 1", "Question 2", "Question 3"]);

    const req = createRequest({
      role: "Backend Engineer",
      type: "Technical",
      level: "Mid",
      amount: 3,
      techstack: "Node.js, PostgreSQL",
      userToken: "valid-firebase-id-token",
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockVerifyIdToken).toHaveBeenCalledWith("valid-firebase-id-token");
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd.mock.calls[0][0].userId).toBe("cryptographically-verified-user");
  });

  it("Security 7: Invalid or expired candidate ID token is strictly REJECTED (401 Unauthorized)", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Token expired"));
    global.fetch = vi.fn();

    const req = createRequest({
      ...validPayload,
      userToken: "expired-or-malformed-token",
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Invalid or expired candidate verification token");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  // ---------------- HAPPY PATH & BUSINESS LOGIC TESTS ----------------

  it("Happy Path: Valid webhook secret with existing candidate UID executes generation and persists interview", async () => {
    mockOpenRouterSuccess([
      "Explain React state management",
      "Describe event loop in JavaScript",
      "What is TypeScript type narrowing",
    ]);

    const req = createRequest(validPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.interviewId).toBe("interview-doc-999");
    expect(data.role).toBe("Frontend Developer");
    expect(data.amount).toBe(3);
    expect(data.techstack).toEqual(["React", "TypeScript"]);
    expect(data.questions).toHaveLength(3);

    // Verify Firestore persistence received verified userId and complete business fields
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const savedDoc = mockAdd.mock.calls[0][0];
    expect(savedDoc.userId).toBe("existing-candidate-uid");
    expect(savedDoc.role).toBe("Frontend Developer");
    expect(savedDoc.finalized).toBe(true);
    expect(savedDoc.coverImage).toBe("/covers/test-cover.png");
    expect(savedDoc.createdAt).toBeDefined();
  });

  it("Happy Path: Also accepts Authorization Bearer header matching VAPI_WEBHOOK_SECRET", async () => {
    mockOpenRouterSuccess(["Valid question"]);

    const req = createRequest(validPayload, {
      authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Authentication: Server secret with trailing newline and quotes matches clean incoming header", async () => {
    process.env.VAPI_WEBHOOK_SECRET = `"${TEST_WEBHOOK_SECRET}\r\n"`;
    mockOpenRouterSuccess(["Valid question"]);

    const req = createRequest(validPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Authentication: Incoming x-vapi-secret with surrounding quotes or whitespace matches server secret", async () => {
    mockOpenRouterSuccess(["Valid question"]);

    const req = createRequest(validPayload, {
      "x-vapi-secret": `  "${TEST_WEBHOOK_SECRET}"  `,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Authentication: Whitespace-only VAPI_WEBHOOK_SECRET fails closed with HTTP 500", async () => {
    process.env.VAPI_WEBHOOK_SECRET = "   \n\t  ";
    const req = createRequest(validPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("VAPI_WEBHOOK_SECRET is not configured");
  });

  it("Authentication: Fallback to VAPI_SECRET succeeds when VAPI_WEBHOOK_SECRET is unset", async () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    process.env.VAPI_SECRET = "fallback-secret-987";
    mockOpenRouterSuccess(["Valid question"]);

    const req = createRequest(validPayload, {
      "x-vapi-secret": "fallback-secret-987",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Authentication: Accepts alternate header variants vapi-secret and x-webhook-secret", async () => {
    mockOpenRouterSuccess(["Valid question"]);

    const req1 = createRequest(validPayload, {
      "vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    const req2 = createRequest(validPayload, {
      "x-webhook-secret": TEST_WEBHOOK_SECRET,
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
  });

  it("Authentication: Accepts raw Authorization header without Bearer prefix", async () => {
    mockOpenRouterSuccess(["Valid question"]);

    const req = createRequest(validPayload, {
      authorization: TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Authentication: Accepts webhook secret in body when headers are omitted", async () => {
    mockOpenRouterSuccess(["Valid question"]);

    const req = createRequest({
      ...validPayload,
      secret: TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Authentication: Accepts ?secret= query parameter fallback", async () => {
    mockOpenRouterSuccess(["Valid question"]);

    const req = new Request(
      `http://localhost:3000/api/vapi/generate?secret=${TEST_WEBHOOK_SECRET}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.interviewId).toBeDefined();
  });

  it("Vapi Payload Unwrapping: Unwraps message.toolCallList payload and returns { results: [{ toolCallId, result }] }", async () => {
    mockOpenRouterSuccess(["What is React state"]);

    const wrappedPayload = {
      message: {
        type: "tool-calls",
        toolCallList: [
          {
            id: "call_vapi_987",
            type: "function",
            function: {
              name: "generate_interview_questions",
              arguments: {
                role: "Fullstack Engineer",
                type: "Technical",
                level: "Mid",
                amount: 3,
                techstack: ["Node.js", "React"],
                userid: "existing-candidate-uid",
              },
            },
          },
        ],
      },
    };

    const req = createRequest(wrappedPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results).toBeDefined();
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results[0].toolCallId).toBe("call_vapi_987");

    const parsedResult = JSON.parse(data.results[0].result);
    expect(parsedResult.success).toBe(true);
    expect(parsedResult.role).toBe("Fullstack Engineer");
    expect(parsedResult.interviewId).toBeDefined();
  });

  it("Vapi Payload Unwrapping: Handles stringified arguments in message.toolCallList", async () => {
    mockOpenRouterSuccess(["Explain TypeScript generics"]);

    const wrappedPayload = {
      message: {
        type: "tool-calls",
        toolCallList: [
          {
            id: "call_vapi_stringified_1",
            type: "function",
            function: {
              name: "generate_interview_questions",
              arguments: JSON.stringify({
                role: "Backend Engineer",
                type: "Technical",
                level: "Senior",
                amount: 2,
                techstack: "Go, PostgreSQL",
                userid: "existing-candidate-uid",
              }),
            },
          },
        ],
      },
    };

    const req = createRequest(wrappedPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results).toBeDefined();
    expect(data.results[0].toolCallId).toBe("call_vapi_stringified_1");
    const parsed = JSON.parse(data.results[0].result);
    expect(parsed.role).toBe("Backend Engineer");
    expect(parsed.techstack).toEqual(["Go", "PostgreSQL"]);
  });

  it("Vapi Payload Unwrapping: Trusted userid in call metadata takes precedence over model-supplied wrong userid", async () => {
    mockOpenRouterSuccess(["Question about CSS"]);

    const wrappedPayload = {
      message: {
        type: "tool-calls",
        toolCallList: [
          {
            id: "call_vapi_metadata_precedence",
            type: "function",
            function: {
              name: "generate_interview_questions",
              arguments: {
                role: "Frontend Engineer",
                type: "Technical",
                level: "Junior",
                amount: 1,
                techstack: ["CSS"],
                userid: "wrong-hallucinated-model-uid",
              },
            },
          },
        ],
        call: {
          metadata: {
            userid: "existing-candidate-uid",
          },
        },
      },
    };

    const req = createRequest(wrappedPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results).toBeDefined();
    expect(data.results[0].toolCallId).toBe("call_vapi_metadata_precedence");

    // Verify Firestore persistence received the trusted candidate UID from call.metadata, NOT the model-supplied one
    expect(mockAdd).toHaveBeenCalled();
    const savedDoc = mockAdd.mock.calls[mockAdd.mock.calls.length - 1][0];
    expect(savedDoc.userId).toBe("existing-candidate-uid");
  });

  // ---------------- VALIDATION & ERROR HANDLING TESTS ----------------

  it("Validation: Missing required interview preferences (role, type, level, amount) are rejected with 400", async () => {
    const authHeaders = { "x-vapi-secret": TEST_WEBHOOK_SECRET };

    // Missing role
    let res = await POST(createRequest({ ...validPayload, role: "" }, authHeaders));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("role");

    // Missing type
    res = await POST(createRequest({ ...validPayload, type: "" }, authHeaders));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("type");

    // Missing level
    res = await POST(createRequest({ ...validPayload, level: "" }, authHeaders));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("level");

    // Missing amount
    const noAmount = { ...validPayload };
    delete (noAmount as Record<string, unknown>).amount;
    res = await POST(createRequest(noAmount, authHeaders));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("amount");
  });

  it("Validation: Invalid question counts (strings, 0, negative, >20) are rejected with 400", async () => {
    const authHeaders = { "x-vapi-secret": TEST_WEBHOOK_SECRET };

    // Non-numeric amount
    let res = await POST(createRequest({ ...validPayload, amount: "invalid-number" }, authHeaders));
    expect(res.status).toBe(400);

    // Amount = 0
    res = await POST(createRequest({ ...validPayload, amount: 0 }, authHeaders));
    expect(res.status).toBe(400);

    // Negative amount
    res = await POST(createRequest({ ...validPayload, amount: -3 }, authHeaders));
    expect(res.status).toBe(400);

    // Amount exceeding maximum 20
    res = await POST(createRequest({ ...validPayload, amount: 25 }, authHeaders));
    expect(res.status).toBe(400);
  });

  it("Validation: Techstack normalization handles string array, comma-separated string, and rejects invalid types", async () => {
    const authHeaders = { "x-vapi-secret": TEST_WEBHOOK_SECRET };
    mockOpenRouterSuccess(["Question 1"]);

    // Comma separated string
    let res = await POST(
      createRequest(
        {
          ...validPayload,
          amount: 1,
          techstack: "React, Next.js , Tailwind",
        },
        authHeaders
      )
    );
    expect(res.status).toBe(200);
    expect(mockAdd.mock.calls[0][0].techstack).toEqual(["React", "Next.js", "Tailwind"]);

    // Invalid non-array non-string techstack
    mockAdd.mockClear();
    res = await POST(
      createRequest(
        {
          ...validPayload,
          amount: 1,
          techstack: 12345,
        },
        authHeaders
      )
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("techstack");
  });

  it("Error: OpenRouter failure returns controlled 502 error and writes no interview document", async () => {
    const authHeaders = { "x-vapi-secret": TEST_WEBHOOK_SECRET };
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const res = await POST(createRequest(validPayload, authHeaders));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Failed to generate");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Error: Database persistence failure returns controlled 500 error", async () => {
    const authHeaders = { "x-vapi-secret": TEST_WEBHOOK_SECRET };
    mockOpenRouterSuccess(["Question 1"]);
    mockAdd.mockRejectedValue(new Error("Firestore connection lost"));

    const res = await POST(createRequest(validPayload, authHeaders));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Database error: Failed to save interview");
  });

  // ---------------- VAPI TOOL EXACT PAYLOAD & SCHEMA COMPATIBILITY ----------------

  it("Vapi Compatibility 1: Accepts exact Vapi request with string amount ('5') and converts to integer 5 in response", async () => {
    mockOpenRouterSuccess(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    const vapiExactPayload = {
      role: "Frontend Developer",
      type: "Technical",
      level: "Senior",
      amount: "5", // Vapi LLM often sends string representation of digits
      techstack: "React, TypeScript", // Comma-delimited string
      userid: "existing-candidate-uid", // Injected via {{userid}} static field
    };

    const req = createRequest(vapiExactPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(typeof data.amount).toBe("number");
    expect(data.amount).toBe(5);
    expect(data.techstack).toEqual(["React", "TypeScript"]);

    const savedDoc = mockAdd.mock.calls[0][0];
    expect(savedDoc.userId).toBe("existing-candidate-uid");
    expect(savedDoc.techstack).toEqual(["React", "TypeScript"]);
  });

  it("Vapi Compatibility 2: Accepts exact Vapi request with array techstack and integer amount", async () => {
    mockOpenRouterSuccess(["Q1", "Q2", "Q3"]);
    const vapiArrayPayload = {
      role: "Full Stack Developer",
      type: "Mixed",
      level: "Lead",
      amount: 3,
      techstack: ["Next.js", "Node.js", "GraphQL"],
      userid: "existing-candidate-uid",
    };

    const req = createRequest(vapiArrayPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.amount).toBe(3);
    expect(data.techstack).toEqual(["Next.js", "Node.js", "GraphQL"]);

    const savedDoc = mockAdd.mock.calls[0][0];
    expect(savedDoc.techstack).toEqual(["Next.js", "Node.js", "GraphQL"]);
  });

  it("Vapi Compatibility 3: Rejects unexpanded literal template '{{userid}}' with 403 Forbidden", async () => {
    const rawTemplatePayload = {
      ...validPayload,
      userid: "{{userid}}", // If variable was unset or misconfigured
    };

    const req = createRequest(rawTemplatePayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Candidate does not exist");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("Vapi Compatibility 4: Handles empty or omitted techstack by normalizing to empty array []", async () => {
    mockOpenRouterSuccess(["Q1"]);
    const noTechPayload = {
      role: "Engineering Manager",
      type: "Behavioral",
      level: "Senior",
      amount: 1,
      techstack: "",
      userid: "existing-candidate-uid",
    };

    const req = createRequest(noTechPayload, {
      "x-vapi-secret": TEST_WEBHOOK_SECRET,
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.techstack).toEqual([]);
    expect(mockAdd.mock.calls[0][0].techstack).toEqual([]);
  });

  it("Health: GET endpoint returns healthy status for uptime checks", async () => {
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });
});
