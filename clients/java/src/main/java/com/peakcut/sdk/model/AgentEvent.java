package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Objects;

/**
 * One line from the live agent-activity feed — e.g. the Scout finding candidate
 * moments, the Critic scoring, or the Surgeon trimming a cut. Streaming these is
 * what makes a job's progress feel alive.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class AgentEvent {

    private final String agent;
    private final String action;
    private final String createdAt;

    public AgentEvent(
            @JsonProperty("agent") String agent,
            @JsonProperty("action") String action,
            @JsonProperty("created_at") String createdAt) {
        this.agent = agent;
        this.action = action;
        this.createdAt = createdAt;
    }

    /** Which agent emitted the event, e.g. {@code "scout"}, {@code "critic"}. */
    public String agent() {
        return agent;
    }

    /** What it did, e.g. {@code "found"}, {@code "written"}. */
    public String action() {
        return action;
    }

    /** ISO-8601 timestamp string as returned by the API. */
    public String createdAt() {
        return createdAt;
    }

    /** A short human-readable rendering, mirroring the web UI's activity feed. */
    public String humanize() {
        return switch (agent == null ? "" : agent) {
            case "scout" -> "Scout is scanning for standout moments";
            case "critic" -> "Critic is scoring candidates";
            case "surgeon" -> "Trimming cuts to clean edges";
            case "hooks" -> "Writing hook titles";
            case "qa" -> "Running quality checks";
            case "copywriter" -> "Writing publish metadata";
            default -> agent == null ? "Working" : agent;
        };
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof AgentEvent other)) {
            return false;
        }
        return Objects.equals(agent, other.agent)
                && Objects.equals(action, other.action)
                && Objects.equals(createdAt, other.createdAt);
    }

    @Override
    public int hashCode() {
        return Objects.hash(agent, action, createdAt);
    }

    @Override
    public String toString() {
        return "AgentEvent{agent=" + agent + ", action=" + action + ", createdAt=" + createdAt + '}';
    }
}
