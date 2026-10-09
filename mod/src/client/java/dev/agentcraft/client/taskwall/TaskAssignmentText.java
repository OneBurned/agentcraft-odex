package dev.agentcraft.client.taskwall;

import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Task;
import java.util.List;

/** Queue roles are planned assignments, not evidence that an agent has started work. */
public final class TaskAssignmentText {
    private TaskAssignmentText() {}

    public static List<String> lines(ForemanState state, Task task) {
        var assignment = task.queueAssignment();
        if (assignment != null) return List.of(
            "Разработчик: " + name(state, task, assignment.developerId()),
            assignment.noReview() ? "Без ревью" : "Ревьюер: " + name(state, task, assignment.reviewerId()));
        // Older bridges only supply an execution assignee. Preserve historical identity.
        if (task.assigneeIdentity() != null) return List.of("Исполнитель: " + task.assigneeLabel());
        return List.of(task.assignee() == null ? "Без исполнителя" : "Исполнитель: " + name(state, task, task.assignee()));
    }

    private static String name(ForemanState state, Task task, String id) {
        if (id == null || id.isBlank()) return "Не назначен";
        var agent = state.agent(id);
        if (agent != null) return agent.name();
        if (task.assigneeIdentity() != null && id.equals(task.assigneeIdentity().id())) return task.assigneeLabel();
        return id;
    }
}
