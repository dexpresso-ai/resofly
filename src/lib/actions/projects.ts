import {
  applyProjectTemplate,
  createProjectTemplate,
  insertRow,
  planTaskInWeek,
  saveProjectTemplateTasks,
  setTaskPlanningPeriod,
  updatePlannerNote,
  updateProjectTemplate,
  updateRow,
} from '../repository';
import { uid } from '../format';
import { flag, list, optText, patchOf, text, type ActionExecutor } from './types';
import type {
  Comment as TaskComment, Priority, ProjectTemplateTaskInput, Task, TaskStatus, TemplateSubtask,
} from '../../types';

/**
 * Uitvoerders voor de project- en planninghandelingen. Elke functie doet precies
 * wat de knop in het scherm doet — zie `supabase/functions/_shared/actions/projects.ts`
 * voor wat er aan de gebruiker beloofd wordt op de kaart die hij goedkeurt.
 */

/** Getal uit de payload; ontbrekend of onleesbaar wordt null (de server valideerde al). */
function optNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Lijst met objecten uit de payload (sjabloontaken). */
function rows(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Deze actie mist "${key}".`);
  return value.map(entry => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}));
}

/** Losse tekstlijst uit de payload (subtaaklabels, titels). */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(s => s.trim()).filter(Boolean) : [];
}

export const PROJECTS_EXECUTORS: Record<string, ActionExecutor> = {
  'project.update_billing': async (payload, ctx) => {
    const projectId = text(payload, 'project_id');
    await updateRow('projects', projectId, patchOf(payload), ctx.organizationId);
    return `Projectinstellingen van "${optText(payload, 'project_name') ?? 'het project'}" bijgewerkt`;
  },

  'project_template.create': async (payload, ctx) => {
    const created = await createProjectTemplate(ctx.organizationId, {
      name: text(payload, 'name'),
      description: optText(payload, 'description'),
    });
    return `Projectsjabloon "${created.name}" aangemaakt — nog zonder standaardtaken`;
  },

  'project_template.update': async (payload, ctx) => {
    const templateId = text(payload, 'template_id');
    const patch = patchOf(payload);
    // updateProjectTemplate kent maar drie velden; de server zet er nooit meer in.
    const updated = await updateProjectTemplate(ctx.organizationId, templateId, {
      ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
      ...('description' in patch ? { description: (patch.description as string | null) ?? null } : {}),
      ...(typeof patch.is_active === 'boolean' ? { is_active: patch.is_active } : {}),
    });
    return `Projectsjabloon "${updated.name}" bijgewerkt`;
  },

  'project_template.set_tasks': async (payload, ctx) => {
    const templateId = text(payload, 'template_id');
    const tasks: ProjectTemplateTaskInput[] = rows(payload, 'tasks').map((task, index) => {
      // Subtaken bewaren we als {id, label}; de id's leven alleen binnen het
      // sjabloon, dus verse id's zijn hier prima — net als in de sjablooneditor.
      const subtasks: TemplateSubtask[] = strings(task.subtask_labels).map(label => ({ id: uid(), label }));
      const existingId = typeof task.id === 'string' && task.id ? task.id : undefined;
      return {
        id: existingId,
        position: typeof task.position === 'number' ? task.position : index,
        title: String(task.title ?? '').trim(),
        description: typeof task.description === 'string' && task.description ? task.description : null,
        status: (task.status as TaskStatus) ?? 'todo',
        priority: (task.priority as Priority) ?? 'med',
        tags: strings(task.tags),
        start_offset_days: optNumber(task, 'start_offset_days'),
        due_offset_days: optNumber(task, 'due_offset_days'),
        planned_offset_days: optNumber(task, 'planned_offset_days'),
        estimated_minutes: optNumber(task, 'estimated_minutes') ?? 60,
        subtasks,
      };
    });
    const saved = await saveProjectTemplateTasks(ctx.organizationId, templateId, tasks);
    const name = optText(payload, 'template_name') ?? 'het sjabloon';
    return `Sjabloon "${name}" heeft nu ${saved.length} standaardta${saved.length === 1 ? 'ak' : 'ken'}`;
  },

  'project_template.apply': async (payload, ctx) => {
    const created = await applyProjectTemplate(
      ctx.organizationId,
      text(payload, 'project_id'),
      text(payload, 'template_id'),
      optText(payload, 'start_date'),
    );
    const template = optText(payload, 'template_name') ?? 'Het sjabloon';
    const project = optText(payload, 'project_name') ?? 'het project';
    return `Sjabloon "${template}" uitgerold op ${project}: ${created} ta${created === 1 ? 'ak' : 'ken'} aangemaakt`;
  },

  'task.add_comment': async (payload, ctx) => {
    const taskId = text(payload, 'task_id');
    // De reacties staan als JSON op de taak zelf; we lezen de huidige lijst uit de
    // geladen werkruimte en zetten de nieuwe erboven — precies wat de taakeditor doet.
    const task = ctx.data.tasks.find(t => t.id === taskId);
    if (!task) throw new Error('Deze taak staat niet in de geladen werkruimte. Ververs de pagina en probeer het opnieuw.');
    const existing: TaskComment[] = Array.isArray(task.comments) ? task.comments : [];
    const comment: TaskComment = { id: uid(), text: text(payload, 'text'), created_at: new Date().toISOString() };
    await updateRow('tasks', taskId, { comments: [comment, ...existing] }, ctx.organizationId);
    return `Reactie geplaatst bij taak "${optText(payload, 'task_title') ?? task.title}"`;
  },

  'task.quick_plan': async (payload, ctx) => {
    const plannedDate = text(payload, 'planned_date');
    const plannedEnd = optText(payload, 'planned_end_date');
    const minutes = optNumber(payload, 'estimated_minutes');
    const priority = optText(payload, 'priority');
    const created = await insertRow<Task>('tasks', ctx.organizationId, {
      title: text(payload, 'title'),
      planned_date: plannedDate,
      // Zelfde bewaking als de snelinvoer: een einddatum die niet ná de plandatum
      // ligt is geen weekstrook maar een gewone dagkaart.
      planned_end_date: plannedEnd && plannedEnd > plannedDate ? plannedEnd : null,
      ...(minutes === null ? {} : { estimated_minutes: Math.round(minutes) }),
      ...(priority ? { priority } : {}),
    });
    return plannedEnd && plannedEnd > plannedDate
      ? `Taak "${created.title}" staat van ${plannedDate} t/m ${plannedEnd} in de weekplanner`
      : `Taak "${created.title}" staat op ${plannedDate} in de weekplanner`;
  },

  'task.set_week_bar': async (payload, ctx) => {
    const plannedDate = text(payload, 'planned_date');
    const plannedEnd = optText(payload, 'planned_end_date');
    const moved = await setTaskPlanningPeriod(ctx.organizationId, text(payload, 'task_id'), plannedDate, plannedEnd);
    const title = optText(payload, 'task_title') ?? moved.title;
    return plannedEnd
      ? `Taak "${title}" loopt nu van ${plannedDate} t/m ${plannedEnd}`
      : `Taak "${title}" staat nu op ${plannedDate}`;
  },

  'task.carry_over': async (payload, ctx) => {
    const toDate = text(payload, 'to_date');
    const taskIds = list(payload, 'task_ids');
    const titles = Array.isArray(payload.titles) ? (payload.titles as unknown[]).map(String) : [];
    // Per taak, zodat één mislukte verplaatsing de rest niet meesleept en je aan de
    // melding ziet welke er wél mee zijn gegaan.
    const failed: string[] = [];
    for (let i = 0; i < taskIds.length; i += 1) {
      try { await planTaskInWeek(ctx.organizationId, taskIds[i], toDate, null); }
      catch { failed.push(titles[i] ?? taskIds[i]); }
    }
    if (failed.length) throw new Error(`${taskIds.length - failed.length} meegenomen, ${failed.length} mislukt (${failed.join(', ')}).`);
    if (taskIds.length === 1) {
      return titles[0] ? `Taak "${titles[0]}" staat nu op ${toDate}` : `Taak staat nu op ${toDate}`;
    }
    return `${taskIds.length} blijven liggen taken staan nu op ${toDate}`;
  },

  'week_action.set_done': async (payload, ctx) => {
    const noteIds = list(payload, 'note_ids');
    const done = flag(payload, 'done');
    const texts = Array.isArray(payload.texts) ? (payload.texts as unknown[]).map(String) : [];
    const failed: string[] = [];
    for (let i = 0; i < noteIds.length; i += 1) {
      try { await updatePlannerNote(ctx.organizationId, noteIds[i], { done }); }
      catch { failed.push(texts[i] ?? noteIds[i]); }
    }
    if (failed.length) throw new Error(`${noteIds.length - failed.length} bijgewerkt, ${failed.length} mislukt (${failed.join(', ')}).`);
    if (noteIds.length === 1) {
      return texts[0]
        ? `Actiepunt "${texts[0]}" ${done ? 'afgevinkt' : 'weer opengezet'}`
        : `Actiepunt ${done ? 'afgevinkt' : 'weer opengezet'}`;
    }
    return `${noteIds.length} actiepunten ${done ? 'afgevinkt' : 'weer opengezet'}`;
  },
};
