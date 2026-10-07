package dev.agentcraft.client.diff;

import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.Task;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** Shared selection for the world card and its click target. No world or renderer dependencies. */
public record ReviewStationCard(Kind kind, @Nullable Decision decision, @Nullable Task task) {
	public enum Kind { MERGE, REVIEW, EMPTY, HIDDEN }

	public static ReviewStationCard select(Collection<Task> tasks, List<Decision> merges, int index) {
		if (index < 0) return new ReviewStationCard(Kind.HIDDEN, null, null);
		// Preserve the existing MERGE row and its ordering, even during studio review.
		if (index < merges.size()) return new ReviewStationCard(Kind.MERGE, merges.get(index), null);
		if (index != 0) return new ReviewStationCard(Kind.HIDDEN, null, null);
		Task latest = tasks.stream().filter(t -> t.studioReview() != null)
			.max(Comparator.<Task, Boolean>comparing(t -> "running".equals(t.studioReview().phase()))
				.thenComparingLong(t -> t.studioReview().startedAt()).thenComparing(Task::id)).orElse(null);
		return new ReviewStationCard(latest == null ? Kind.EMPTY : Kind.REVIEW, null, latest);
	}

	public String status(boolean stale) {
		if (kind != Kind.REVIEW || task == null) return "";
		if (stale) return "Нет связи";
		var review = task.studioReview();
		return switch (review.phase()) {
			case "running" -> "Идёт ревью";
			case "paused" -> "Ревью на паузе";
			case "error" -> "Ошибка ревью";
			case "finished" -> review.verdict() == null ? "Ревью завершено" : review.verdict();
			default -> "Статус неизвестен";
		};
	}

	public String detail() {
		if (kind != Kind.REVIEW || task == null) return "";
		var r = task.studioReview();
		String text = "running".equals(r.phase()) ? r.step() : r.summary();
		return text == null ? "" : text.replaceAll("\\s+", " ").trim();
	}
}
