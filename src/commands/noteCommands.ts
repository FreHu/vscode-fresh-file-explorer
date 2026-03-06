import * as vscode from "vscode";
import { PinnedItemsProvider } from "../fresh-files/pinnedItemsProvider";
import { NoteTreeItem } from "../fresh-files/freshFileTreeItems";
import { log } from "../extension/logger";

export async function handleAddNote(pinnedItemsProvider: PinnedItemsProvider): Promise<void> {
  const noteText = await vscode.window.showInputBox({
    prompt: "Enter note text",
    placeHolder: "Type your note here...",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Note cannot be empty";
      }
      if (value.length > 150) {
        return noteTooLongMessage;
      }
      return null;
    }
  });

  if (noteText && noteText.trim().length > 0) {
    pinnedItemsProvider.pinnedItemsManager.addNote(noteText.trim());
    log(`Note added via command`);
  }
}

export async function handleEditNote(item: NoteTreeItem, pinnedItemsProvider: PinnedItemsProvider): Promise<void> {
  const newText = await vscode.window.showInputBox({
    prompt: "Edit note text",
    value: item.noteText,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Note cannot be empty";
      }
      if (value.length > 150) {
        return noteTooLongMessage;
      }
      return null;
    }
  });

  if (newText && newText.trim().length > 0 && newText !== item.noteText) {
    pinnedItemsProvider.pinnedItemsManager.updateNote(item.noteId, newText.trim());
    log(`Note edited: ${item.noteId}`);
  }
}

export function handleToggleNoteCompleted(item: NoteTreeItem, pinnedItemsProvider: PinnedItemsProvider): void {
  pinnedItemsProvider.pinnedItemsManager.toggleNoteCompleted(item.noteId);
  log(`Note toggled completed: ${item.noteId}`);
}

export async function handleDeleteNote(item: NoteTreeItem, pinnedItemsProvider: PinnedItemsProvider): Promise<void> {
  pinnedItemsProvider.pinnedItemsManager.removeNote(item.noteId);
  log(`Note deleted: ${item.noteId}`);
}

export async function handleClearAllPinned(pinnedItemsProvider: PinnedItemsProvider): Promise<void> {
  const result = await vscode.window.showWarningMessage(
    "Clear all pinned items?",
    { modal: true },
    "Clear All"
  );
  
  if (result === "Clear All") {
    pinnedItemsProvider.pinnedItemsManager.clearAllPinned();
    log("Cleared all pinned items");
  }
}

export function handleClearCompleted(pinnedItemsProvider: PinnedItemsProvider): void {
  pinnedItemsProvider.pinnedItemsManager.clearCompleted();
  log("Cleared completed notes");
}

const noteTooLongMessage = "Note is too long (max 150 characters). You could make a file and pin that instead.";