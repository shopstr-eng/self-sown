import React, {
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Community, CommunityPost, NostrEvent } from "@/utils/types/types";
import {
  NostrContext,
  SignerContext,
} from "../utility-components/nostr-context-provider";
import {
  fetchCommunityPosts,
  fetchPendingPosts,
} from "@/utils/nostr/fetch-service";
import {
  Button,
  Textarea,
  Card,
  CardBody,
  Divider,
  Chip,
} from "@nextui-org/react";
import MilkMarketSpinner from "../utility-components/mm-spinner";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import {
  createCommunityPost,
  approveCommunityPost,
  retractApproval,
} from "@/utils/nostr/nostr-helper-functions";
import { ProfileWithDropdown } from "../utility-components/profile/profile-dropdown";
import { sanitizeUrl } from "@braintree/sanitize-url";
import FailureModal from "../utility-components/failure-modal";
import SuccessModal from "../utility-components/success-modal";

interface CommunityFeedProps {
  community: Community;
}

const isImage = (url: string) => /\.(jpeg|jpg|gif|png|webp)$/i.test(url);
const isVideo = (url: string) => /\.(mp4|webm|mov)$/i.test(url);
const isYouTube = (url: string) =>
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(.+)/i.test(
    url
  );

const RenderContent = ({
  content,
  tags,
}: {
  content: string;
  tags: string[][];
}) => {
  const parts = content.split(/(\s+)/);
  const taggedImages = tags
    .filter((tag) => tag[0] === "image")
    .map((tag) => tag[1]);

  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-dark-text">
        {parts.map((part, index) => {
          if (isImage(part)) {
            return (
              <img
                key={index}
                src={sanitizeUrl(part)}
                alt="User content"
                className="mt-2 max-h-96 rounded-lg"
              />
            );
          }
          if (isVideo(part)) {
            return (
              <video
                key={index}
                src={sanitizeUrl(part)}
                controls
                className="mt-2 max-h-96 rounded-lg"
              />
            );
          }
          if (isYouTube(part)) {
            const videoId = part.match(
              /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(.+)/i
            )?.[1];
            return (
              <iframe
                key={index}
                className="mt-2 aspect-video w-full rounded-lg"
                src={sanitizeUrl(`https://www.youtube.com/embed/${videoId}`)}
                title="YouTube video player"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              ></iframe>
            );
          }
          return part;
        })}
      </p>
      {taggedImages.length > 0 && (
        <div className="pt-2">
          {taggedImages.map((url, index) => (
            <img
              key={index}
              src={sanitizeUrl(url)}
              alt="Tagged media"
              className="mt-2 max-h-96 rounded-lg"
            />
          ))}
        </div>
      )}
    </div>
  );
};

const CommunityFeed: React.FC<CommunityFeedProps> = ({ community }) => {
  const { nostr } = useContext(NostrContext);
  const { signer, pubkey } = useContext(SignerContext);
  const [approvedPosts, setApprovedPosts] = useState<CommunityPost[]>([]);
  const [pendingPosts, setPendingPosts] = useState<NostrEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newPostContent, setNewPostContent] = useState("");

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");

  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showFailureModal, setShowFailureModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [failureMessage, setFailureMessage] = useState("");

  const isModerator = pubkey ? community.moderators.includes(pubkey) : false;

  const loadPosts = useCallback(async () => {
    if (nostr) {
      setIsLoading(true);
      // fetch approved posts (annotated with approval metadata)
      const approved = (await fetchCommunityPosts(
        nostr,
        community,
        50
      )) as CommunityPost[];
      setApprovedPosts(approved);

      if (isModerator) {
        const pending = await fetchPendingPosts(nostr, community, 50);
        setPendingPosts(pending);
      }
      setIsLoading(false);
    }
  }, [community, nostr, isModerator]);

  useEffect(() => {
    loadPosts();
  }, [loadPosts]);

  const handlePost = async () => {
    if (!signer || !nostr || !newPostContent.trim()) return;
    try {
      const newPost = await createCommunityPost(
        signer,
        nostr,
        community,
        newPostContent
      );
      setNewPostContent("");
      // Optimistically add the new post to the pending list FIRST
      if (newPost) {
        setPendingPosts((prevPending) => [newPost, ...prevPending]);
      }
      setSuccessMessage(
        "Your post has been submitted for approval. It will appear once a moderator approves it."
      );
      setShowSuccessModal(true);
    } catch (error) {
      console.error("Failed to create post", error);
      setFailureMessage("Failed to create post.");
      setShowFailureModal(true);
    }
  };

  const handleReply = async (parentPost: NostrEvent) => {
    if (!signer || !nostr || !replyContent.trim()) return;
    try {
      const newReply = await createCommunityPost(
        signer,
        nostr,
        community,
        replyContent,
        { parentEvent: parentPost }
      );
      setReplyContent("");
      setReplyingTo(null);
      // Optimistically add the new reply to the pending list FIRST
      if (newReply) {
        setPendingPosts((prevPending) => [newReply, ...prevPending]);
      }
      setSuccessMessage(
        "Your reply has been submitted for approval. It will appear once a moderator approves it."
      );
      setShowSuccessModal(true);
    } catch (error) {
      console.error("Failed to submit reply", error);
      setFailureMessage("Failed to submit reply.");
      setShowFailureModal(true);
    }
  };

  const handleApprove = async (postToApprove: NostrEvent) => {
    if (!signer || !nostr) return;
    try {
      const signedApproval = await approveCommunityPost(
        signer,
        nostr,
        postToApprove,
        community
      );
      // optimistic: remove from pending, add to approved with approval metadata
      setPendingPosts((prev) => prev.filter((p) => p.id !== postToApprove.id));
      const ap: CommunityPost = {
        ...(postToApprove as CommunityPost),
        approved: true,
        approvalEventId: signedApproval?.id,
        approvedBy: signedApproval?.pubkey,
      };
      setApprovedPosts((prev) =>
        [ap, ...prev].sort((a, b) => b.created_at - a.created_at)
      );
    } catch (error) {
      console.error("Failed to approve post", error);
      setFailureMessage("Failed to approve post.");
      setShowFailureModal(true);
    }
  };

  const handleRetractApproval = async (approvalEventId?: string) => {
    if (!signer || !nostr || !approvalEventId) return;
    try {
      await retractApproval(
        signer,
        nostr,
        approvalEventId,
        "Retracted by moderator"
      );
      // optimistic: move that post from approved back to pending
      setApprovedPosts((prev) =>
        prev.filter((p) => p.approvalEventId !== approvalEventId)
      );
      // reload pending posts shortly
      const pending = await fetchPendingPosts(nostr, community, 50);
      setPendingPosts(pending);
    } catch (error) {
      console.error("Failed to retract approval", error);
      setFailureMessage("Failed to retract approval.");
      setShowFailureModal(true);
    }
  };

  // For display, combine pending and approved posts (approved have metadata)
  const { topLevelPosts, repliesByParentId } = useMemo(() => {
    const approvedIds = new Set(approvedPosts.map((p) => p.id));
    const allPosts = [
      ...approvedPosts,
      ...pendingPosts.filter((p) => !approvedIds.has(p.id)),
    ].sort((a, b) => b.created_at - a.created_at);

    const topLevelPosts: CommunityPost[] = [];
    const repliesByParentId = new Map<string, CommunityPost[]>();

    for (const post of allPosts) {
      const parentId = post.tags.find((tag) => tag[0] === "e")?.[1];

      if (parentId) {
        if (!repliesByParentId.has(parentId)) {
          repliesByParentId.set(parentId, []);
        }
        repliesByParentId.get(parentId)!.push(post);
      } else {
        // It's a top-level post
        topLevelPosts.push(post);
      }
    }

    for (const replies of repliesByParentId.values()) {
      replies.reverse();
    }

    return { topLevelPosts, repliesByParentId };
  }, [approvedPosts, pendingPosts]);

  return (
    <div className="space-y-6">
      {isModerator && (
        <Card className="bg-dark-fg">
          <CardBody>
            <h3 className="mb-2 text-lg font-bold text-dark-text">
              Create an Announcement
            </h3>
            <Textarea
              value={newPostContent}
              onChange={(e) => setNewPostContent(e.target.value)}
              placeholder="What's on your mind?"
              minRows={3}
              className="text-dark-text"
            />
            <Button
              onClick={handlePost}
              className={`${WHITEBUTTONCLASSNAMES} mt-2 self-end`}
              disabled={!newPostContent.trim()}
            >
              Post
            </Button>
          </CardBody>
        </Card>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8">
          <MilkMarketSpinner label="Loading posts..." />
        </div>
      ) : (
        <div className="space-y-4">
          {topLevelPosts.map((post: CommunityPost) => (
            <React.Fragment key={post.id}>
              <Card className="bg-dark-fg">
                <CardBody>
                  <div className="mb-4 flex items-center justify-between">
                    <ProfileWithDropdown
                      pubkey={post.pubkey}
                      baseClassname="justify-start hover:bg-dark-bg pl-4 rounded-3xl py-2 hover:scale-105 hover:shadow-lg"
                      dropDownKeys={["shop_profile", "copy_npub"]}
                      nameClassname="md:block"
                      bg="dark"
                    />
                    {isModerator && !post.approved && (
                      <Chip color="warning" variant="flat">
                        Pending Approval
                      </Chip>
                    )}
                  </div>
                  <RenderContent content={post.content} tags={post.tags} />
                  <Divider className="my-4 bg-dark-text" />
                  <div className="flex items-center justify-between">
                    <Button
                      size="sm"
                      variant="light"
                      onClick={() =>
                        setReplyingTo(replyingTo === post.id ? null : post.id)
                      }
                      className={
                        replyingTo === post.id
                          ? "text-red-500"
                          : "text-yellow-600"
                      }
                    >
                      {replyingTo === post.id ? "Cancel" : "Reply"}
                    </Button>
                    {isModerator && !post.approved && (
                      <Button
                        size="sm"
                        onClick={() => handleApprove(post)}
                        className="min-w-fit bg-gradient-to-tr from-yellow-700 via-yellow-500 to-yellow-700 text-light-text shadow-lg"
                      >
                        Approve
                      </Button>
                    )}
                    {isModerator &&
                      post.approved &&
                      post.approvalEventId &&
                      post.approvedBy === pubkey && (
                        <Button
                          size="sm"
                          onClick={() =>
                            handleRetractApproval(post.approvalEventId)
                          }
                          className="min-w-fit bg-gradient-to-tr from-red-600 via-red-500 to-red-600 text-white shadow-lg"
                        >
                          Retract Approval
                        </Button>
                      )}
                  </div>
                  {replyingTo === post.id && (
                    <div className="mt-4 border-t-2 pt-4">
                      <Textarea
                        value={replyContent}
                        onChange={(e) => setReplyContent(e.target.value)}
                        placeholder={`Replying to ${post.pubkey.slice(
                          0,
                          8
                        )}...`}
                        minRows={2}
                        className="text-dark-text"
                      />
                      <Button
                        onClick={() => handleReply(post)}
                        className={`${WHITEBUTTONCLASSNAMES} mt-2 self-end`}
                        disabled={!replyContent.trim()}
                        size="sm"
                      >
                        Submit Reply
                      </Button>
                    </div>
                  )}
                </CardBody>
              </Card>

              {/* Render Replies */}
              {repliesByParentId.has(post.id) && (
                <div className="ml-8 space-y-4 border-l-2 border-zinc-200 bg-dark-fg pl-4">
                  {repliesByParentId
                    .get(post.id)!
                    .map((reply: CommunityPost) => (
                      <Card key={reply.id} className="bg-dark-fg">
                        <CardBody>
                          <div className="mb-4 flex items-center justify-between">
                            <ProfileWithDropdown
                              pubkey={reply.pubkey}
                              baseClassname="justify-start hover:bg-dark-bg pl-4 rounded-3xl py-2 hover:scale-105 hover:shadow-lg"
                              dropDownKeys={["shop_profile", "copy_npub"]}
                              nameClassname="md:block"
                              bg="dark"
                            />
                            {isModerator && !reply.approved && (
                              <Chip color="warning" variant="flat">
                                Pending Approval
                              </Chip>
                            )}
                          </div>
                          <RenderContent
                            content={reply.content}
                            tags={reply.tags}
                          />
                          <Divider className="my-4 bg-dark-text" />
                          <div className="flex items-center justify-between">
                            <Button
                              size="sm"
                              variant="light"
                              onClick={() =>
                                setReplyingTo(
                                  replyingTo === reply.id ? null : reply.id
                                )
                              }
                              className={
                                replyingTo === reply.id
                                  ? "text-red-500"
                                  : "text-yellow-600"
                              }
                            >
                              {replyingTo === reply.id ? "Cancel" : "Reply"}
                            </Button>
                            {isModerator && !reply.approved && (
                              <Button
                                size="sm"
                                onClick={() => handleApprove(reply)}
                                className="min-w-fit bg-gradient-to-tr from-yellow-700 via-yellow-500 to-yellow-700 text-light-text shadow-lg"
                              >
                                Approve
                              </Button>
                            )}
                          </div>
                          {replyingTo === reply.id && (
                            <div className="mt-4 border-t-2 pt-4">
                              <Textarea
                                value={replyContent}
                                onChange={(e) =>
                                  setReplyContent(e.target.value)
                                }
                                placeholder={`Replying to ${reply.pubkey.slice(
                                  0,
                                  8
                                )}...`}
                                minRows={2}
                                className="text-dark-text"
                              />
                              <Button
                                onClick={() => handleReply(reply)}
                                className={`${WHITEBUTTONCLASSNAMES} mt-2 self-end`}
                                disabled={!replyContent.trim()}
                                size="sm"
                              >
                                Submit Reply
                              </Button>
                            </div>
                          )}
                        </CardBody>
                      </Card>
                    ))}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
      {!isLoading && topLevelPosts.length === 0 && (
        <div className="mt-10 text-center text-light-text/80">
          <p>No announcements yet. Check back soon!</p>
        </div>
      )}

      <SuccessModal
        bodyText={successMessage}
        isOpen={showSuccessModal}
        onClose={() => {
          setShowSuccessModal(false);
          setSuccessMessage("");
        }}
      />

      <FailureModal
        bodyText={failureMessage}
        isOpen={showFailureModal}
        onClose={() => {
          setShowFailureModal(false);
          setFailureMessage("");
        }}
      />
    </div>
  );
};

export default CommunityFeed;
