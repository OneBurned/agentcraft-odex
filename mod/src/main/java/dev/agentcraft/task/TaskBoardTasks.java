package dev.agentcraft.task;

/** Selection shared by the wall and its task/history browser. No persisted task is removed. */
public final class TaskBoardTasks {
    private TaskBoardTasks() {}

    public static boolean finished(String stage) {
        return "done".equals(stage) || "cancelled".equals(stage);
    }

    public static boolean visible(boolean observer, String queueStage, String status, boolean history) {
        if (observer && (queueStage == null || queueStage.isBlank())) return false;
        String stage = queueStage == null || queueStage.isBlank() ? status : queueStage;
        if (stage == null || stage.equals("unknown")) return false;
        return finished(stage) == history;
    }

    /** Queue stage is authoritative; generic BLOCKED alone cannot distinguish a draft from a question. */
    public static String stage(String queueStage, String status, boolean started) {
        if (queueStage != null && !queueStage.isBlank()) return queueStage;
        return switch (status == null ? "unknown" : status) {
            case "doing" -> "coding";
            case "todo" -> "queued";
            case "blocked" -> started ? "coding" : "queued";
            default -> status == null ? "unknown" : status;
        };
    }

    public static String label(String stage) {
        return switch (stage) {
            case "plan" -> "План";
            case "queued" -> "В очереди";
            case "coding" -> "В работе";
            case "review" -> "Ревью";
            case "question" -> "Нужно решение";
            case "done" -> "Готово";
            case "cancelled" -> "Отменена";
            default -> stage;
        };
    }
}
