/**
 * Frozen 0.6.0 tool surface, kept as an A/B baseline only.
 *
 * Set DSH_RELAY_SURFACE=full to serve this instead of the lean surface, so a
 * caller can measure both against the same task. Nothing else imports it.
 * Delete this file (and the switch in surface.mjs) once the lean surface is
 * proven; it exists to be compared against, not to be maintained.
 */
export const FULL_INSTRUCTIONS = "DSH Agent Control — drive DSH agents inside a running DeepSeek Harness instance.\nTreat a DSH session as a subagent you can delegate to: it keeps its own context across\ncalls, works in the workspace you name, and returns a final answer.\n\n- dsh_list_sessions: find a sessionId to continue, or see what DSH is doing.\n- dsh_models: list the provider/model ids this instance can route, with reasoning efforts.\n- dsh_delegate: create a session in a workspace (or continue one via sessionId), send an\n  instruction, and block until the turn finishes, returning the final output.\n- dsh_answer: answer a question DSH asked, so its agent can resume.\n- dsh_approval: choose how a session resolves FUTURE approval requests.\n- dsh_cancel: cancel the active turn — the way out of a blocked approval.\n- dsh_poll: check a session that is still running or was left waiting.\n\nWorkflow: dsh_delegate({ workspace, instruction }). Omit sessionId to start a new DSH\nagent; keep the returned sessionId and pass it back to continue the SAME agent (it\nremembers prior work). Then read status:\n  completed = output is the final answer.\n  timeout   = still working; call dsh_poll({ sessionId, baselineSeq }).\n  waiting   = blocked on a human. waiting.kind says which:\n    \"user-question\" + intercepted:true -> answer it with dsh_answer({ sessionId, answers })\n        using the ids in waiting.detail. If intercepted is false the question is sitting in\n        the DSH GUI instead and only a person there can answer it.\n    \"approval\" -> an operation needs a decision before DSH will run it, and this one is\n        already pending: only a person in the DSH GUI can approve it, or dsh_cancel\n        abandons the turn. waiting.detail carries the tool, the callId and the reason\n        DSH gave. dsh_approval({ sessionId, mode }) only changes FUTURE approvals:\n        \"deny\" rejects them at once, \"gui\" leaves them to the GUI.\n\nChoosing a model: a session runs on this instance's default model unless you say otherwise.\nCall dsh_models for the ids it can route, then pass model (plus provider and reasoningEffort\nwhen you want to pin them) to dsh_delegate; it applies to that turn. The choice is also saved\nas the instance default for later sessions, exactly as the DSH model picker behaves, so pick\ndeliberately and say so when you do. Omit model to leave the session on what it already uses.\n\nRules: reuse a sessionId to continue the SAME line of work — a new session loses that context —\nbut never reuse it for a different task. Pass an absolute path as workspace when creating a\nsession. Resolve a waiting state yourself\n(answer the question, decide the approval) unless it genuinely needs a human. Do not poll\nin a short-timeout loop: dsh_delegate already blocks until the turn ends. A tool call that\nis merely still running is NOT a wait — the session stays \"running\" and reports a\npendingTool field. DSH agents have their own sandbox policy and cannot write outside\ntheir workspace. Unanswered questions fall back to the DSH GUI after about three minutes.\n\nHouse rules for this deployment:\n- One task per session: start a new session for each new task, and a fresh one once the context\n  has grown long. Do not pile unrelated work into an old session.\n- Always pass an absolute workspace path when creating a session.\n- Default model: DeepSeek 4.1 Flash with a vision plugin, so it can read images — but the results\n  can be inaccurate. Give it only simple image-reading tasks. A different model is usable only\n  when dsh_models lists it; check before promising one.\n- Never delegate visual design (drawing, web page layout, application UI, art): the model cannot\n  do it. For front-end work, supply a detailed written spec or a visual mockup first.\n- Do not check progress often; look in only when the user asks you to go faster.\n- Use these tools only when the user asks. If, after analysing the work, you think part of it suits\n  DSH, propose that and wait for agreement — do not start a delegation on your own initiative.\n- The user normally sets the workspace up in advance and names it, usually the same workspace you\n  (Codex) are already working in. If no workspace was given, ask whether to use your own workspace\n  before creating a session — do not assume it."

export const FULL_TOOLS = [
  {
    "name": "dsh_list_sessions",
    "description": "List sessions of the running DSH instance, optionally filtered to one workspace. Use this to discover an existing sessionId to continue, or to check what DSH is doing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "workspace": {
          "type": "string",
          "description": "Absolute workspace path to filter by (exact match). Omit to list all sessions."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "dsh_models",
    "description": "List the models this DSH instance can route right now, grouped by provider, with each model's reasoning efforts. Use the ids here as dsh_delegate's model / provider / reasoningEffort. Also reports the instance default used by sessions nobody has configured.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "dsh_delegate",
    "description": "Delegate a task to a DSH agent, like handing work to a subagent. Creates a new session in the given workspace (or continues an existing one when sessionId is supplied), sends the instruction, and by default blocks until that turn finishes and returns its final output. Pass the returned sessionId back in later calls to keep working with the same DSH agent. If DSH blocks on a human question it returns status \"waiting\" immediately rather than hanging. Pass model to run this delegation on a model you choose (call dsh_models first for the ids).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "instruction": {
          "type": "string",
          "description": "The task instruction for the DSH agent."
        },
        "workspace": {
          "type": "string",
          "description": "Absolute workspace path; used as cwd when creating a new session."
        },
        "sessionId": {
          "type": "string",
          "description": "Continue this existing DSH session instead of creating a new one."
        },
        "mode": {
          "type": "string",
          "enum": [
            "queue",
            "steer"
          ],
          "description": "queue (default) appends after the current turn; steer injects into the running turn."
        },
        "agentPreset": {
          "type": "string",
          "description": "Optional agent preset id for a newly created session."
        },
        "model": {
          "type": "string",
          "description": "Model id to run this turn on, e.g. \"deepseek-v4.1-flash\". Accepts \"provider/model\" too. Omit to leave the session (or the instance default) alone. Get ids from dsh_models. The choice also becomes this instance's saved default, exactly as the DSH model picker does."
        },
        "provider": {
          "type": "string",
          "description": "Provider route for model (e.g. \"deepseek\"). Optional: it is inferred when the model id is unambiguous, or from \"provider/model\"."
        },
        "reasoningEffort": {
          "type": "string",
          "description": "Optional reasoning effort id for the chosen model, such as \"high\". Only ids dsh_models lists for that model are valid; omit to take the model's default."
        },
        "takeover": {
          "type": "boolean",
          "description": "Default true. Routes this session's ask_user_question calls to you instead of the DSH GUI, so you answer them with dsh_answer. If you never answer, the question falls back to the GUI after about 3 minutes."
        },
        "wait": {
          "type": "boolean",
          "description": "Block until the turn completes (default true). Set false to return immediately."
        },
        "timeoutMs": {
          "type": "number",
          "description": "Maximum time to wait for completion (default 600000)."
        }
      },
      "required": [
        "instruction"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "dsh_answer",
    "description": "Answer a question that DSH asked while takeover was on, letting its agent continue. Use the sessionId and the question ids from the \"waiting\" block returned by dsh_delegate or dsh_poll.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "The DSH session that is waiting."
        },
        "answers": {
          "type": "array",
          "description": "One entry per question, keyed by the question id.",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Question id from waiting.detail."
              },
              "selected": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Selected option labels."
              },
              "custom": {
                "type": "string",
                "description": "Free-text answer instead of a listed option."
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "sessionId",
        "answers"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "dsh_poll",
    "description": "Check a DSH session: whether it is running, waiting on a human, or idle, plus its latest assistant output. Use after a dsh_delegate that timed out or returned \"waiting\", or to follow long-running work.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "The DSH session to inspect."
        },
        "baselineSeq": {
          "type": "number",
          "description": "Only report completion once the log passes this cursor (from dsh_delegate)."
        },
        "timeoutMs": {
          "type": "number",
          "description": "If greater than zero, block until settled, blocked-on-human, or this timeout elapses."
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "dsh_approval",
    "description": "Decide how a DSH session resolves approval requests — operations DSH refuses to run without a decision. \"gui\" (the default) leaves them to the DSH Web GUI for a person to answer. \"auto-approve\" grants them automatically for that session. \"deny\" makes them fail immediately, so an unattended delegation stops instead of blocking forever.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "The DSH session to configure."
        },
        "mode": {
          "type": "string",
          "enum": [
            "gui",
            "auto-approve",
            "deny"
          ],
          "description": "How approval requests for this session should be resolved."
        }
      },
      "required": [
        "sessionId",
        "mode"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "dsh_cancel",
    "description": "Cancel the active turn of a DSH session. Use it to abandon a turn that is blocked on an approval nobody can answer, or one that is running too long. Only the running turn stops; messages already queued inside DSH keep going.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "The DSH session whose active turn should stop."
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  }
]
