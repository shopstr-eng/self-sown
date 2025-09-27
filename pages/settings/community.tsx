/* eslint-disable @next/next/no-img-element */

import React, { useContext, useEffect, useState } from "react";
import {
  Divider,
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
} from "@nextui-org/react";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import { CommunityContext } from "@/utils/context/context";
import {
  createOrUpdateCommunity,
  deleteEvent,
} from "@/utils/nostr/nostr-helper-functions";
import CreateCommunityForm from "@/components/communities/CreateCommunityForm";
import { Community } from "@/utils/types/types";
import {
  BLACKBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";

const CommunityManagementPage = () => {
  const { signer, pubkey } = useContext(SignerContext);
  const { nostr } = useContext(NostrContext);
  const { communities, isLoading } = useContext(CommunityContext);
  const [myCommunities, setMyCommunities] = useState<Community[]>([]);
  const [communityToEdit, setCommunityToEdit] = useState<
    Community | "new" | null
  >(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordStorageKey, setPasswordStorageKey] = useState<string>("");

  useEffect(() => {
    const fetchPasswordStorageKey = async () => {
      try {
        const response = await fetch("/api/validate-password-auth", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });
        const data = await response.json();
        if (data.value) {
          setPasswordStorageKey(data.value);
          const storedAuth = localStorage.getItem(data.value);
          if (storedAuth === "true") {
            setIsAuthenticated(true);
          }
        }
      } catch (error) {
        console.error("Failed to fetch password storage key:", error);
      }
    };

    fetchPasswordStorageKey();
  }, []);

  useEffect(() => {
    if (pubkey && communities.size > 0) {
      const userCommunities = Array.from(communities.values()).filter(
        (c) => c.pubkey === pubkey
      );
      setMyCommunities(userCommunities);
    }
  }, [pubkey, communities]);

  const handleSave = async (data: {
    name: string;
    description: string;
    image: string;
    d: string;
  }) => {
    if (!signer || !nostr || !pubkey) {
      alert("You must be logged in to create or update a community.");
      return;
    }
    try {
      await createOrUpdateCommunity(signer, nostr, {
        ...data,
        moderators: [pubkey], // Add creator as a moderator
      });
      alert("Community saved! It may take a few moments to appear.");
      setCommunityToEdit(null);
    } catch (error) {
      console.error("Failed to save community", error);
      alert("Failed to save community.");
    }
  };

  const handleDelete = async (communityId: string) => {
    if (!signer || !nostr) return;

    const isConfirmed = window.confirm(
      "Are you sure you want to delete this community? This action cannot be undone."
    );

    if (isConfirmed) {
      try {
        await deleteEvent(nostr, signer, [communityId]);
        alert(
          "Community deletion request sent. It may take a few moments to disappear from relays."
        );
        // Optimistically remove from the local list
        setMyCommunities((prev) => prev.filter((c) => c.id !== communityId));
      } catch (error) {
        console.error("Failed to delete community", error);
        alert("Failed to delete community.");
      }
    }
  };

  const handleCreateNewCommunity = () => {
    if (isAuthenticated) {
      setCommunityToEdit("new");
    } else {
      setShowPasswordModal(true);
    }
  };

  const handlePasswordSubmit = async () => {
    try {
      const response = await fetch("/api/validate-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: passwordInput.trim() }),
      });

      const data = await response.json();

      if (data.valid) {
        setIsAuthenticated(true);
        if (passwordStorageKey) {
          localStorage.setItem(passwordStorageKey, "true");
        }
        setShowPasswordModal(false);
        setCommunityToEdit("new");
        setPasswordInput("");
        setPasswordError("");
      } else {
        setPasswordError("Incorrect password. Please try again.");
      }
    } catch (error) {
      setPasswordError("An error occurred. Please try again.");
    }
  };

  const handlePasswordModalClose = () => {
    setShowPasswordModal(false);
    setPasswordInput("");
    setPasswordError("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handlePasswordSubmit();
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-light-bg pt-24 md:pb-20">
      <div className="mx-auto h-full w-full px-4 lg:w-1/2">
        <SettingsBreadCrumbs />

        {communityToEdit ? (
          // Show the Form for Creating or Editing
          <>
            <h2 className="mb-2 text-2xl font-bold text-light-text">
              {communityToEdit === "new"
                ? "Create Your Community"
                : `Editing: ${communityToEdit.name}`}
            </h2>
            <p className="mb-4 text-light-text/80">
              Create a space for your customers to gather and get updates.
            </p>
            <Divider className="my-4" />
            <CreateCommunityForm
              existingCommunity={
                communityToEdit === "new" ? null : communityToEdit
              }
              onSave={handleSave}
              onCancel={() => setCommunityToEdit(null)}
            />
          </>
        ) : (
          // Show the List of Communities
          <>
            <div className="mb-6 flex w-full items-center justify-between">
              <h2 className="text-2xl font-bold text-light-text">
                Your Communities
              </h2>
              <Button
                className={BLACKBUTTONCLASSNAMES}
                onClick={handleCreateNewCommunity}
              >
                Create New
              </Button>
            </div>

            {isLoading && myCommunities.length === 0 ? (
              <MilkMarketSpinner label="Loading your communities..." />
            ) : myCommunities.length > 0 ? (
              <div className="space-y-2">
                {myCommunities.map((community) => (
                  <div
                    key={community.id}
                    className="flex items-center justify-between rounded-lg bg-dark-fg p-3"
                  >
                    <span className="font-semibold text-dark-text">
                      {community.name}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => setCommunityToEdit(community)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        color="danger"
                        variant="flat"
                        onClick={() => handleDelete(community.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-light-text/80">
                You haven&apos;t created any communities yet.
              </p>
            )}
          </>
        )}

        <Modal
          backdrop="blur"
          isOpen={showPasswordModal}
          onClose={handlePasswordModalClose}
          classNames={{
            body: "py-6 bg-dark-fg",
            backdrop: "bg-[#292f46]/50 backdrop-opacity-60",
            header: "border-b-[1px] border-[#292f46] bg-dark-fg rounded-t-lg",
            footer: "border-t-[1px] border-[#292f46] bg-dark-fg rounded-b-lg",
            closeButton: "hover:bg-black/5 active:bg-white/10",
          }}
          scrollBehavior={"outside"}
          size="md"
          isDismissable={true}
        >
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1 text-dark-text">
              Enter Seller Password
            </ModalHeader>
            <ModalBody>
              <Input
                className="text-dark-text"
                autoFocus
                variant="flat"
                label="Password"
                labelPlacement="inside"
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyDown={handleKeyDown}
                isInvalid={!!passwordError}
                errorMessage={passwordError}
              />
              {passwordError && (
                <div className="mt-2 text-sm text-red-500">{passwordError}</div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button
                color="danger"
                variant="light"
                onClick={handlePasswordModalClose}
              >
                Cancel
              </Button>
              <Button
                className={`bg-gradient-to-tr text-white shadow-lg ${WHITEBUTTONCLASSNAMES}`}
                onClick={handlePasswordSubmit}
                isDisabled={!passwordInput.trim()}
              >
                Submit
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </div>
    </div>
  );
};

export default CommunityManagementPage;
