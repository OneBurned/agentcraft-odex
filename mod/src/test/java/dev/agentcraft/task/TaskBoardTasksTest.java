package dev.agentcraft.task;

import org.junit.Test;
import static org.junit.Assert.*;

public class TaskBoardTasksTest {
    @Test public void observerProgressNeverCrowdsPoolOrHistory() {
        for (String status : new String[] {"todo", "doing", "blocked", "review", "done", "cancelled"}) {
            assertFalse(TaskBoardTasks.visible(true, null, status, false));
            assertFalse(TaskBoardTasks.visible(true, null, status, true));
        }
    }

    @Test public void poolLifecycleMovesToHistoryOnlyOnCompletionOrCancellation() {
        String[] stages = {"plan", "queued", "coding", "review", "question", "done", "cancelled"};
        String[] wire = {"todo", "todo", "doing", "review", "blocked", "done", "cancelled"};
        for (int i = 0; i < stages.length; i++) {
            boolean history = i >= 5;
            assertEquals(stages[i], !history, TaskBoardTasks.visible(true, stages[i], wire[i], false));
            assertEquals(stages[i], history, TaskBoardTasks.visible(true, stages[i], wire[i], true));
            assertEquals(stages[i], TaskBoardTasks.stage(stages[i], wire[i], true));
        }
        assertEquals("План", TaskBoardTasks.label(TaskBoardTasks.stage("plan", "todo", false)));
        assertEquals("Нужно решение", TaskBoardTasks.label(TaskBoardTasks.stage("question", "blocked", true)));
    }

    @Test public void queueStageWinsOverGenericTaskStatus() {
        assertTrue(TaskBoardTasks.visible(true, "review", "done", false));
        assertFalse(TaskBoardTasks.visible(true, "review", "done", true));
        assertTrue(TaskBoardTasks.visible(true, "done", "doing", true));
    }

    @Test public void legacyBackendsKeepRealTasksWithoutQueueStage() {
        assertTrue(TaskBoardTasks.visible(false, null, "doing", false));
        assertTrue(TaskBoardTasks.visible(false, null, "blocked", false));
        assertTrue(TaskBoardTasks.visible(false, null, "done", true));
        assertTrue(TaskBoardTasks.visible(false, null, "cancelled", true));
        assertEquals("queued", TaskBoardTasks.stage(null, "blocked", false));
        assertEquals("coding", TaskBoardTasks.stage(null, "blocked", true));
        assertFalse(TaskBoardTasks.visible(false, null, "unknown", false));
        assertFalse(TaskBoardTasks.visible(false, null, null, false));
    }
}
