package dev.agentcraft.client.taskwall;

import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.task.TaskBoardTasks;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Readable, paged index; finished tasks remain accessible without crowding the wall. */
public final class TaskBoardScreen extends Screen {
    private record Row(Task task, int y, List<String> title, String meta) {}
    private final List<Row> rows = new ArrayList<>();
    private boolean history;
    private int page, pages, x, y, w, h;
    private long taskSeq = -1, agentSeq = -1;

    public TaskBoardScreen(boolean history) {
        super(Component.literal("Доска задач"));
        this.history = history;
    }

    @Override public boolean isPauseScreen() { return false; }
    @Override protected void init() { layout(); }
    @Override public void tick() {
        if (taskSeq != TaskWallFeature.taskSeq() || agentSeq != TaskWallFeature.agentSeq()) layout();
    }

    private Button button(String label, int bx, int by, int bw, Runnable action) {
        return addRenderableWidget(Button.builder(Component.literal(label), b -> action.run()).bounds(bx, by, bw, 20).build());
    }

    private void layout() {
        clearWidgets(); rows.clear();
        taskSeq = TaskWallFeature.taskSeq(); agentSeq = TaskWallFeature.agentSeq();
        w = Math.min(640, width - 16); h = Math.min(460, height - 16);
        x = (width - w) / 2; y = (height - h) / 2;
        var state = Foreman.state();
        List<Task> active = new ArrayList<>(), past = new ArrayList<>();
        if (state != null) for (Task t : state.tasks().values()) {
            if (TaskBoard.shown(state, t, false)) active.add(t);
            if (TaskBoard.shown(state, t, true)) past.add(t);
        }
        active.sort(Comparator.comparing(TaskBoard::colOf)
            .thenComparing(Comparator.comparingInt(Task::priority).reversed()).thenComparingLong(Task::createdAt));
        past.sort(Comparator.comparingLong(Task::updatedAt).reversed());
        int bw = (w - 28) / 2;
        button("Текущие · " + active.size(), x + 12, y + 29, bw, () -> { history = false; page = 0; layout(); }).active = history;
        button("История · " + past.size(), x + 16 + bw, y + 29, bw, () -> { history = true; page = 0; layout(); }).active = !history;
        List<Task> tasks = history ? past : active;
        int count = Math.max(1, (h - 118) / 55);
        pages = Math.max(1, (tasks.size() + count - 1) / count);
        page = Math.min(page, pages - 1);
        int rowY = y + 57;
        for (int i = page * count; i < Math.min(tasks.size(), (page + 1) * count); i++) {
            Task t = tasks.get(i);
            var titleLines = TextUtil.wrapPlain(font, TaskBoard.titleText(t), w - 42);
            if (titleLines.size() > 2) titleLines = List.of(titleLines.get(0), TextUtil.ellipsize(font, String.join(" ", titleLines.subList(1, titleLines.size())), w - 42));
            var agent = state.agent(t.assignee());
            String name = agent == null ? "Без исполнителя" : agent.name();
            String stage = TaskBoardTasks.stage(t.queueStage(), t.status().wire(), t.branch() != null || t.worktree() != null);
            rows.add(new Row(t, rowY, titleLines, t.id() + " · " + TaskBoardTasks.label(stage) + " · " + name));
            Button row = Button.builder(Component.empty(), b -> minecraft.gui.setScreen(TaskScreen.forTask(t.id(), this)))
                .bounds(x + 12, rowY, w - 24, 51)
                .createNarration(supplier -> Component.literal(t.id() + " · " + TaskBoard.titleText(t)))
                .tooltip(Tooltip.create(Component.literal(TaskBoard.titleText(t) + "\nОткрыть полную карточку"))).build();
            addRenderableWidget(row);
            rowY += 55;
        }
        button("←", x + 12, y + h - 42, 28, () -> { page--; layout(); }).active = page > 0;
        button("→", x + 44, y + h - 42, 28, () -> { page++; layout(); }).active = page + 1 < pages;
        button("Закрыть", x + w - 92, y + h - 42, 80, this::onClose);
    }

    @Override public void extractBackground(GuiGraphicsExtractor g, int mx, int my, float dt) { extractTransparentBackground(g); }
    @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) {
        g.fill(x, y, x + w, y + h, 0xFFF4EFE6);
        g.fill(x, y, x + w, y + 2, 0xFFC9A227);
        g.text(font, title, x + 12, y + 12, 0xFF1F1E1D);
        super.extractRenderState(g, mx, my, dt);
        for (Row row : rows) {
            int ty = row.y + 7;
            for (String line : row.title) { g.text(font, line, x + 20, ty, 0xFFFFFFFF); ty += 11; }
            g.text(font, TextUtil.ellipsize(font, row.meta, w - 42), x + 20, row.y + 36, 0xFFFFE3A8);
        }
        if (rows.isEmpty()) {
            String empty = !Foreman.connected() ? "Нет связи с мостом" : history ? "В истории пока нет задач" : "Текущих задач нет. Добавь задачу в план.";
            int ty = y + 65;
            for (String line : TextUtil.wrapPlain(font, empty, w - 32)) { g.text(font, line, x + 16, ty, 0xFF655E55); ty += 12; }
        }
        g.text(font, (page + 1) + " / " + pages, x + 82, y + h - 36, 0xFF655E55);
        g.text(font, TextUtil.ellipsize(font, history ? "Готово означает завершение задачи, а не установку обновления." : "Нажми на задачу, чтобы открыть описание и действия.", w - 24), x + 12, y + h - 15, 0xFF655E55);
    }
}
