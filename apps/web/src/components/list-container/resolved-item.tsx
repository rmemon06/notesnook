/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import {
  Color,
  Item,
  ItemMap,
  ItemType,
  Reminder,
  VirtualizedGrouping
} from "@notesnook/core";
import usePromise from "../../hooks/use-promise";
import {
  NotebooksWithDateEdited,
  TagsWithDateEdited,
  WithDateEdited
} from "./types";
import { db } from "../../common/db";
import React from "react";

type ResolvedItemProps<TItemType extends ItemType> = {
  type: TItemType;
  items: VirtualizedGrouping<ItemMap[TItemType]>;
  index: number;
  children: (item: {
    item: ItemMap[TItemType];
    data: unknown;
  }) => React.ReactNode;
};
export function ResolvedItem<TItemType extends ItemType>(
  props: ResolvedItemProps<TItemType>
) {
  const { index, items, children, type } = props;
  const result = usePromise(
    () => items.item(index, resolveItems),
    [index, items]
  );

  if (result.status !== "fulfilled" || !result.value) return null;

  if (result.value.item.type !== type) return null;
  return <>{children(result.value)}</>;
}

export function useResolvedItem(
  props: Omit<ResolvedItemProps<ItemType>, "children" | "type">
) {
  const { index, items } = props;
  const result = usePromise(
    () => items.item(index, resolveItems),
    [index, items]
  );

  if (result.status !== "fulfilled" || !result.value) return null;
  return result.value;
}

function withDateEdited<
  T extends { dateEdited: number } | { dateModified: number }
>(items: T[]): WithDateEdited<T> {
  let latestDateEdited = 0;
  items.forEach((item) => {
    const date = "dateEdited" in item ? item.dateEdited : item.dateModified;
    if (latestDateEdited < date) latestDateEdited = date;
  });
  return { dateEdited: latestDateEdited, items };
}

export async function resolveItems(ids: string[], items: Item[]) {
  const { type } = items[0];
  if (type === "note") return resolveNotes(ids);
  else if (type === "notebook") {
    return Promise.all(ids.map((id) => db.notebooks.totalNotes(id)));
  } else if (type === "tag") {
    return Promise.all(
      ids.map((id) => db.relations.from({ id, type: "tag" }, "note").count())
    );
  }
  return [];
}

type NoteResolvedData = {
  notebooks?: NotebooksWithDateEdited;
  reminder?: Reminder;
  color?: Color;
  tags?: TagsWithDateEdited;
};
async function resolveNotes(ids: string[]) {
  console.time("relations");
  const relations = [
    ...(await db.relations
      .to({ type: "note", ids }, ["notebook", "tag", "color"])
      .get()),
    ...(await db.relations.from({ type: "note", ids }, "reminder").get())
  ];
  console.timeEnd("relations");
  const relationIds: {
    notebooks: Set<string>;
    colors: Set<string>;
    tags: Set<string>;
    reminders: Set<string>;
  } = {
    colors: new Set(),
    notebooks: new Set(),
    tags: new Set(),
    reminders: new Set()
  };

  const grouped: Record<
    string,
    {
      notebooks: string[];
      color?: string;
      tags: string[];
      reminder?: string;
    }
  > = {};
  for (const relation of relations) {
    const noteId =
      relation.toType === "reminder" ? relation.fromId : relation.toId;
    const data = grouped[noteId] || {
      notebooks: [],
      tags: []
    };

    if (relation.toType === "reminder" && !data.reminder) {
      data.reminder = relation.toId;
      relationIds.reminders.add(relation.toId);
    } else if (relation.fromType === "notebook" && data.notebooks.length < 2) {
      data.notebooks.push(relation.fromId);
      relationIds.notebooks.add(relation.fromId);
    } else if (relation.fromType === "tag" && data.tags.length < 3) {
      data.tags.push(relation.fromId);
      relationIds.tags.add(relation.fromId);
    } else if (relation.fromType === "color" && !data.color) {
      data.color = relation.fromId;
      relationIds.colors.add(relation.fromId);
    }
    grouped[noteId] = data;
  }

  console.time("resolve");
  const resolved = {
    notebooks: await db.notebooks.all.records(
      Array.from(relationIds.notebooks)
    ),
    tags: await db.tags.all.records(Array.from(relationIds.tags)),
    colors: await db.colors.all.records(Array.from(relationIds.colors)),
    reminders: await db.reminders.all.records(Array.from(relationIds.reminders))
  };
  console.timeEnd("resolve");

  const data: NoteResolvedData[] = [];
  for (const noteId in grouped) {
    const group = grouped[noteId];
    data.push({
      color: group.color ? resolved.colors[group.color] : undefined,
      reminder: group.reminder ? resolved.reminders[group.reminder] : undefined,
      tags: withDateEdited(group.tags.map((id) => resolved.tags[id])),
      notebooks: withDateEdited(
        group.notebooks.map((id) => resolved.notebooks[id])
      )
    });
  }
  return data;
}

export function isNoteResolvedData(data: unknown): data is NoteResolvedData {
  return (
    typeof data === "object" &&
    !!data &&
    "notebooks" in data &&
    "reminder" in data &&
    "color" in data &&
    "tags" in data
  );
}
