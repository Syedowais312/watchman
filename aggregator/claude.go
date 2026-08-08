package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

const claudeSystemPrompt = `You are Watchman, an assistant embedded in a live Kubernetes observability dashboard.

You may ONLY use the JSON event log provided in the user message to answer. Every event is a real overload incident the aggregator measured (service, metric, peak_value, start_time, end_time, duration, active).

Never invent a service, a number, or an incident that isn't in the log. If the log doesn't answer the question, say so plainly instead of guessing. Keep answers to 1-2 sentences.`

// AskClaude answers a question grounded in the given overload events, using
// Claude Haiku 4.5. Returns an error if the API key is unset or the call
// fails, so the caller can fall back to the offline rule-based matcher.
func AskClaude(ctx context.Context, apiKey, question string, events []OverloadEvent) (string, error) {
	if apiKey == "" {
		return "", errors.New("ANTHROPIC_API_KEY not set")
	}

	eventsJSON, err := json.Marshal(events)
	if err != nil {
		return "", fmt.Errorf("marshal events: %w", err)
	}

	client := anthropic.NewClient(option.WithAPIKey(apiKey))

	userContent := fmt.Sprintf("Event log (JSON):\n%s\n\nQuestion: %s", eventsJSON, question)

	resp, err := client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     "claude-haiku-4-5",
		MaxTokens: 256,
		System: []anthropic.TextBlockParam{
			{Text: claudeSystemPrompt},
		},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(userContent)),
		},
	})
	if err != nil {
		return "", fmt.Errorf("claude request: %w", err)
	}

	for _, block := range resp.Content {
		if text, ok := block.AsAny().(anthropic.TextBlock); ok {
			return text.Text, nil
		}
	}
	return "", errors.New("claude returned no text content")
}
