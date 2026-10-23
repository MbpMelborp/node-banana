"use client";

import { Dialog, splitPanelClass } from "@/components/ui/Dialog";
import { useState, useCallback, useEffect } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { TemplateExplorerView } from "./TemplateExplorerView";
import { WorkflowBrowserView } from "./WorkflowBrowserView";
import { BringInView } from "./BringInView";
import { fetchProjects } from "@/lib/assets/client/api";
import { cn } from "@/components/nodes/ui/cn";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile, directoryPath?: string) => void;
  onClose: () => void;
  onNewProject: () => void;
  /** Opens an empty canvas with the agent window open. */
  onStartWithAgent: () => void;
  /** View to open on; the menu's Templates entry passes "templates", Settings › Storage "bringIn". */
  initialView?: QuickstartView;
}

/**
 * The welcome dialog is a split dialog: every view keeps the dark pane on
 * the left and swaps what it carries (the identity, the template filters,
 * the folder). Sizes are the design canvas's: 820×470 for the initial
 * and browse views; the template explorer is 1200×720, the model
 * browser's size, so two columns of cards get the same room.
 */
const VIEW_SIZE: Record<QuickstartView, string> = {
  initial: "w-[820px] h-[470px]",
  browse: "w-[820px] h-[470px]",
  bringIn: "w-[820px] h-[470px]",
  templates: "w-[1200px] h-[720px]",
};

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
  onNewProject,
  onStartWithAgent,
  initialView = "initial",
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>(initialView);
  // Only someone with no known projects is asked whether they used Creativo Melborp before
  const [noProjects, setNoProjects] = useState(false);

  // A second request while open (Settings › Storage's "Choose folder…") switches the view
  useEffect(() => {
    setCurrentView(initialView);
  }, [initialView]);

  useEffect(() => {
    const controller = new AbortController();
    fetchProjects(controller.signal)
      .then((overview) => setNoProjects(overview.projects.length === 0))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleNewProject = useCallback(() => {
    onNewProject();
  }, [onNewProject]);

  const handleSelectTemplates = useCallback(() => {
    setCurrentView("templates");
  }, []);

  const handleSelectLoad = useCallback(() => {
    setCurrentView("browse");
  }, []);

  const handleBack = useCallback(() => {
    setCurrentView("initial");
  }, []);

  const handleSelectBringIn = useCallback(() => {
    setCurrentView("bringIn");
  }, []);

  // Once they are in, Open lists them
  const handleBroughtIn = useCallback(() => {
    setNoProjects(false);
    setCurrentView("browse");
  }, []);

  const handleWorkflowSelected = useCallback(
    (workflow: WorkflowFile) => {
      onWorkflowGenerated(workflow);
    },
    [onWorkflowGenerated]
  );

  return (
    <Dialog
      open
      onClose={onClose}
      label="Welcome"
      className={cn(splitPanelClass, "max-w-[92vw] max-h-[85vh]", VIEW_SIZE[currentView])}
    >
      {currentView === "initial" && (
        <QuickstartInitialView
          onNewProject={handleNewProject}
          onSelectTemplates={handleSelectTemplates}
          onStartWithAgent={onStartWithAgent}
          onSelectLoad={handleSelectLoad}
          onBringIn={noProjects ? handleSelectBringIn : undefined}
        />
      )}
      {currentView === "templates" && (
        <TemplateExplorerView
          onBack={handleBack}
          onWorkflowSelected={handleWorkflowSelected}
        />
      )}
      {currentView === "browse" && (
        <WorkflowBrowserView
          onBack={handleBack}
          onWorkflowLoaded={(workflow, dirPath) =>
            onWorkflowGenerated(workflow, dirPath)
          }
          onClose={onClose}
          onNewProject={handleNewProject}
          onBringIn={handleSelectBringIn}
        />
      )}
      {currentView === "bringIn" && (
        <BringInView
          // Opened straight onto Bring-in (from Settings), Back and Cancel close
          onBack={initialView === "bringIn" ? undefined : handleBack}
          onClose={onClose}
          onDone={handleBroughtIn}
        />
      )}
    </Dialog>
  );
}
