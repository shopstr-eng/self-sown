import { useState, useContext, useEffect } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { Image } from "@nextui-org/react";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  BLACKBUTTONCLASSNAMES,
  PRIMARYBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";

// YouTube Carousel Component
function YouTubeCarousel() {
  const [videos, setVideos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/youtube-videos")
      .then((res) => res.json())
      .then((data) => {
        if (data.videos) {
          setVideos(data.videos);
        } else {
          setError(true);
        }
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-black border-t-transparent"></div>
      </div>
    );
  }

  if (error || videos.length === 0) {
    return (
      <div className="rounded-lg border-2 border-black bg-white p-8 text-center">
        <p className="text-zinc-600">
          Unable to load videos at this time. Please check our YouTube channel
          directly.
        </p>
      </div>
    );
  }

  return (
    <div className="relative max-w-[84vw] overflow-hidden">
      <div className="animate-scroll flex gap-6 will-change-transform">
        {/* Duplicate videos for seamless loop */}
        {[...videos, ...videos].map((video, index) => (
          <a
            key={`${video.id}-${index}`}
            href={`https://www.youtube.com/watch?v=${video.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="group block w-80 flex-shrink-0 overflow-hidden rounded-lg border-2 border-black bg-white shadow-neo transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none"
          >
            <div className="relative aspect-video overflow-hidden">
              <Image
                src={video.thumbnail}
                alt={video.title}
                className="h-full w-full object-cover duration-300 transition-transform group-hover:scale-105"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-0 transition-all group-hover:bg-opacity-20">
                <div className="rounded-full bg-red-600 p-3 opacity-0 transition-opacity group-hover:opacity-100">
                  <svg
                    className="h-6 w-6 text-white"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                  </svg>
                </div>
              </div>
            </div>
            <div className="p-4">
              <h3 className="mb-2 line-clamp-2 font-bold text-black">
                {video.title}
              </h3>
              <p className="line-clamp-2 text-sm text-zinc-600">
                {video.description}
              </p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

export default function StandaloneLanding() {
  const router = useRouter();
  const [contactType, setContactType] = useState<"email" | "nostr">("email");
  const [contact, setContact] = useState("");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const signerContext = useContext(SignerContext);
  useEffect(() => {
    if (router.pathname === "/" && signerContext.isLoggedIn) {
      router.push("/marketplace");
    }
  }, [router.pathname, signerContext]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contact.trim() || !isValidContact) return;

    setIsSubmitting(true);
    setSubmitMessage(null);

    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contact: contact.trim(),
          contactType,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setSubmitMessage({
          type: "success",
          text: "Thanks for signing up! We'll keep you updated on new features and products.",
        });
        setContact("");
      } else {
        setSubmitMessage({
          type: "error",
          text: data.error || "Something went wrong! Please try again.",
        });
      }
    } catch (error) {
      setSubmitMessage({
        type: "error",
        text: "Network error! Please check your connection and try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValidEmail = (email: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const isValidNostrPub = (npub: string) => {
    return npub.startsWith("npub") && npub.length === 63;
  };

  const isValidContact =
    contactType === "email" ? isValidEmail(contact) : isValidNostrPub(contact);

  // Component for Plus Pattern Background
  const PlusPattern = () => (
    <div className="pointer-events-none absolute inset-0 opacity-[0.03]">
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern
            id="plus-pattern"
            x="0"
            y="0"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 20 0 L 20 40 M 0 20 L 40 20"
              stroke="#000000"
              strokeWidth="2"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#plus-pattern)" />
      </svg>
    </div>
  );

  return (
    <div className="w-full overflow-x-hidden bg-white font-sans text-black">
      {/* ================================================================================= */}
      {/* Navigation Section */}
      {/* ================================================================================= */}
      <nav className="relative z-20 mx-auto flex max-w-7xl items-center justify-between p-4 md:p-6">
        <div className="flex items-center space-x-2">
          <Image
            src="/milk-market.png"
            alt="Milk Market"
            width={32}
            height={32}
            className="h-8 w-8"
          />
          <span className="text-xl font-bold">Milk Market</span>
        </div>

        {/* Desktop Navigation */}
        <div className="hidden md:flex md:items-center md:space-x-4">
          <Link href="/producers" className="w-auto">
            <button className={WHITEBUTTONCLASSNAMES}>Sell Your Dairy</button>
          </Link>
          <button
            onClick={() => {
              const signupSection = document.getElementById("signup");
              if (signupSection) {
                signupSection.scrollIntoView({ behavior: "smooth" });
              }
            }}
            className={BLACKBUTTONCLASSNAMES}
          >
            Get Updates
          </button>
          <Link href="/marketplace" className="w-auto">
            <button className={PRIMARYBUTTONCLASSNAMES}>
              Browse Milk Market
            </button>
          </Link>
        </div>

        {/* Mobile Navigation */}
        <div className="relative md:hidden">
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="z-50 rounded-md border-2 border-black bg-white p-2"
          >
            {isMobileMenuOpen ? (
              <XMarkIcon className="h-6 w-6 text-black" />
            ) : (
              <Bars3Icon className="h-6 w-6 text-black" />
            )}
          </button>
          {isMobileMenuOpen && (
            <div className="fixed inset-0 top-20 z-40 flex flex-col items-center space-y-6 bg-white pt-10">
              <Link href="/producers" className="w-auto">
                <button
                  className={WHITEBUTTONCLASSNAMES}
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  Sell Your Dairy
                </button>
              </Link>
              <button
                className={BLACKBUTTONCLASSNAMES}
                onClick={() => {
                  const signupSection = document.getElementById("signup");
                  if (signupSection) {
                    signupSection.scrollIntoView({ behavior: "smooth" });
                  }
                  setIsMobileMenuOpen(false);
                }}
              >
                Get Updates
              </button>
              <Link href="/marketplace" className="block">
                <button
                  className={PRIMARYBUTTONCLASSNAMES}
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  Browse Milk Market
                </button>
              </Link>
            </div>
          )}
        </div>
      </nav>

      {/* ================================================================================= */}
      {/* Hero Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 overflow-hidden border-b-2 border-black bg-grid-pattern px-4 pb-12 pt-12 sm:px-6 lg:px-8">
        {/* Plus Pattern Background */}
        <PlusPattern />

        {/* Floating Milk Cartons */}
        <div className="animate-float-slow pointer-events-none absolute left-[15%] top-[10%] opacity-[0.06]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={80}
            height={80}
            className="h-20 w-20"
          />
        </div>
        <div className="animate-float-medium pointer-events-none absolute right-[20%] top-[25%] opacity-[0.04]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={120}
            height={120}
            className="h-30 w-30"
          />
        </div>
        <div className="animate-float-fast pointer-events-none absolute bottom-[15%] left-[10%] opacity-[0.08]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={100}
            height={100}
            className="h-25 w-25"
          />
        </div>
        <div className="animate-float-slow pointer-events-none absolute bottom-[20%] right-[12%] opacity-[0.05]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={90}
            height={90}
            className="h-22 w-22"
          />
        </div>

        <div className="relative z-10 mx-auto max-w-5xl text-center">
          <div className="mb-6 flex justify-center space-x-4">
            <span className="text-4xl">🐄</span>
            <span className="text-4xl">🐐</span>
            <span className="text-4xl">🥛</span>
            <span className="text-4xl">🚜</span>
          </div>

          <h1 className="mb-6 text-4xl font-black leading-tight md:text-6xl">
            Raw Dairy Direct from <br />
            <span className="relative inline-block">
              <span className="relative z-10 inline-block rounded-lg border-[3px] border-black bg-black px-4 py-2 text-white">
                Local Farmers
              </span>
              <span className="absolute bottom-[-5px] right-[-5px] z-0 h-full w-full rounded-lg border-[3px] border-black bg-primary-yellow"></span>
            </span>
          </h1>

          <p className="mx-auto mb-8 max-w-2xl text-base text-zinc-600">
            Connect with trusted local dairy farmers and access farm-fresh, raw
            milk and dairy products. Our marketplace, built with sovereignty and
            community in mind, ensures secure transactions while directly
            supporting farmers in your area.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link href="/marketplace">
              <button
                className={`${PRIMARYBUTTONCLASSNAMES} flex items-center gap-2`}
              >
                Discover Local Dairy 🥛
              </button>
            </Link>
            <Link href="/producers">
              <button
                className={`${WHITEBUTTONCLASSNAMES} flex items-center gap-2`}
              >
                Start Selling Today 🚜
              </button>
            </Link>
            <button
              onClick={() => {
                const signupSection = document.getElementById("signup");
                if (signupSection) {
                  signupSection.scrollIntoView({ behavior: "smooth" });
                }
              }}
              className={`${BLACKBUTTONCLASSNAMES} flex items-center gap-2`}
            >
              Stay Milky 📨
            </button>
            <Link href="/faq">
              <button
                className={`${WHITEBUTTONCLASSNAMES} flex items-center gap-2`}
              >
                Learn More 🙋
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Why Choose Us Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 border-b-2 border-black bg-zinc-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-black md:text-5xl">
              Why Choose Milk Market for Raw Dairy?
            </h2>
            <p className="text-lg text-zinc-600">
              Connecting consumers with trusted dairy producers
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-3">
            <div className="cursor-pointer rounded-lg border-2 border-black bg-white p-8 text-center shadow-neo transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none">
              <span className="mb-4 block text-4xl">🚜</span>
              <h3 className="mb-4 text-xl font-bold">Direct from Farm</h3>
              <p className="text-zinc-600">
                Skip the grocery store and get farm-fresh raw milk, cheese, and
                dairy products directly from local farmers. Support farmers
                while enjoying the freshest dairy available in your area.
              </p>
            </div>
            <div className="cursor-pointer rounded-lg border-2 border-black bg-white p-8 text-center shadow-neo transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none">
              <span className="mb-4 block text-4xl">🤝</span>
              <h3 className="mb-4 text-xl font-bold">Peer-to-Peer Payments</h3>
              <p className="text-zinc-600">
                Pay your farmer directly and securely with Bitcoin, cash, or
                other digital cash methods. Our permissionless platform ensures
                your transactions are private and secure without intermediaries,
                with fees at your control.
              </p>
            </div>
            <div className="cursor-pointer rounded-lg border-2 border-black bg-white p-8 text-center shadow-neo transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none">
              <span className="mb-4 block text-4xl">🫂</span>
              <h3 className="mb-4 text-xl font-bold">Community Focused</h3>
              <p className="text-zinc-600">
                Build relationships with local dairy farmers and support your
                community&apos;s agricultural economy. Access farm-fresh
                products while contributing to sustainable local food systems.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* How It Works Section */}
      {/* ================================================================================= */}
      <section
        id="how-it-works"
        className="relative z-10 overflow-hidden bg-grid-pattern py-20"
        style={{ borderBottom: "2px solid black" }}
      >
        {/* Plus Pattern Background */}
        <PlusPattern />

        {/* Floating Milk Cartons */}
        <div className="animate-float-fast pointer-events-none absolute left-[8%] top-[12%] opacity-[0.07]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={110}
            height={110}
            className="h-28 w-28"
          />
        </div>
        <div className="animate-float-medium pointer-events-none absolute right-[15%] top-[35%] opacity-[0.05]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={95}
            height={95}
            className="h-24 w-24"
          />
        </div>
        <div className="animate-float-slow pointer-events-none absolute bottom-[10%] left-[18%] opacity-[0.06]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={105}
            height={105}
            className="h-26 w-26"
          />
        </div>
        <div className="animate-float-fast pointer-events-none absolute bottom-[25%] right-[8%] opacity-[0.08]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={85}
            height={85}
            className="h-21 w-21"
          />
        </div>

        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-black md:text-5xl">
              How Milk Market Works
            </h2>
            <p className="text-lg text-zinc-600">
              Simple steps to get farm-fresh raw dairy
            </p>
          </div>

          <div className="grid gap-16 lg:grid-cols-2">
            {/* Producers */}
            <div>
              <div className="mb-8 flex items-center">
                <span className="mr-4 text-3xl">🚜</span>
                <h3 className="text-3xl font-black">Producers</h3>
              </div>

              <div className="space-y-8">
                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black font-bold text-white">
                    1
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-bold">List Your Milk</h4>
                    <p className="text-zinc-600">
                      Add products to the marketplace with a few clicks
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black font-bold text-white">
                    2
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-bold">Set Terms</h4>
                    <p className="text-zinc-600">
                      Define price, delivery type, and preferred payment methods
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black font-bold text-white">
                    3
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-bold">
                      Grow Your Business
                    </h4>
                    <p className="text-zinc-600">
                      Leverage our online community to expand your customer base
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Drinkers */}
            <div>
              <div className="mb-8 flex items-center">
                <span className="mr-4 text-3xl">🥛</span>
                <h3 className="text-3xl font-black">Drinkers</h3>
              </div>

              <div className="space-y-8">
                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black font-bold text-white">
                    1
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-bold">
                      Local-first Connections
                    </h4>
                    <p className="text-zinc-600">
                      Find and support farmers in your city, state, and country
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black font-bold text-white">
                    2
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-bold">Secure Checkout</h4>
                    <p className="text-zinc-600">
                      Choose Bitcoin, cash, or other digital cash options
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black font-bold text-white">
                    3
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-bold">
                      From Farm to Table
                    </h4>
                    <p className="text-zinc-600">
                      Schedule pickups and deliveries directly with producers
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Explore Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 border-b-2 border-black bg-zinc-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="mb-8 text-4xl font-black">Explore Milk Market</h2>
            <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
              <Link
                href="/marketplace"
                className="group block rounded-lg border-2 border-black bg-white p-6 shadow-neo transition-transform hover:-translate-y-1"
              >
                <span className="mb-2 block text-4xl">🥛</span>
                <span className="block font-bold">Browse Products</span>
              </Link>
              <Link
                href="/producers"
                className="group block rounded-lg border-2 border-black bg-white p-6 shadow-neo transition-transform hover:-translate-y-1"
              >
                <span className="mb-2 block text-4xl">🚜</span>
                <span className="block font-bold">Start Selling</span>
              </Link>
              <Link
                href="/communities"
                className="group block rounded-lg border-2 border-black bg-white p-6 shadow-neo transition-transform hover:-translate-y-1"
              >
                <span className="mb-2 block text-4xl">🫂</span>
                <span className="block font-bold">View Communities</span>
              </Link>
              <Link
                href="/faq"
                className="group block rounded-lg border-2 border-black bg-white p-6 shadow-neo transition-transform hover:-translate-y-1"
              >
                <span className="mb-2 block text-4xl">❓</span>
                <span className="block font-bold">FAQ</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* YouTube Videos Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 overflow-hidden border-b-2 border-black bg-grid-pattern py-20">
        {/* Plus Pattern Background */}
        <PlusPattern />

        {/* Floating Milk Cartons */}
        <div className="animate-float-medium pointer-events-none absolute left-[12%] top-[18%] opacity-[0.06]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={90}
            height={90}
            className="h-22 w-22"
          />
        </div>
        <div className="animate-float-slow pointer-events-none absolute right-[10%] top-[8%] opacity-[0.05]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={115}
            height={115}
            className="h-29 w-29"
          />
        </div>
        <div className="animate-float-fast pointer-events-none absolute bottom-[12%] left-[22%] opacity-[0.07]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={100}
            height={100}
            className="h-25 w-25"
          />
        </div>
        <div className="animate-float-medium pointer-events-none absolute bottom-[30%] right-[18%] opacity-[0.04]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={95}
            height={95}
            className="h-24 w-24"
          />
        </div>

        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-black md:text-5xl">
              Latest from Our Channel
            </h2>
            <p className="text-lg text-zinc-600">
              Keep up with our latest videos and content
            </p>
          </div>

          <div className="flex items-center justify-center">
            <YouTubeCarousel />
          </div>

          <div className="mt-8 text-center">
            <a
              href="https://www.youtube.com/@milkmarketmedia"
              target="_blank"
              rel="noopener noreferrer"
              className={`${PRIMARYBUTTONCLASSNAMES} inline-flex items-center gap-2`}
            >
              Visit Our Channel
              <span className="text-xl">📺</span>
            </a>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Benefits Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 border-b-2 border-black bg-zinc-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-black md:text-5xl">
              Benefits of Local Raw Dairy
            </h2>
            <p className="text-lg text-zinc-600">
              Superior nutrition and community impact
            </p>
          </div>

          <div className="mx-auto max-w-6xl">
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="cursor-pointer rounded-lg border-2 border-black bg-white p-8 shadow-neo transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none">
                <h3 className="mb-4 text-2xl font-bold">
                  Nutritional Excellence
                </h3>
                <p className="mb-6 text-zinc-600">
                  Farm-fresh, minimally processed dairy from grass-fed animals
                  provides superior nutrition. Raw milk contains beneficial
                  enzymes, probiotics, and vitamins that are often lost in
                  commercial processing.
                </p>
                <ul className="space-y-3 text-zinc-600">
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Higher vitamin and mineral content
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Natural probiotics for gut health
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    No artificial additives or preservatives
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Better digestibility for many people
                  </li>
                </ul>
              </div>

              <div className="cursor-pointer rounded-lg border-2 border-black bg-white p-8 shadow-neo transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none">
                <h3 className="mb-4 text-2xl font-bold">Community Impact</h3>
                <p className="mb-6 text-zinc-600">
                  Supporting local dairy farmers promotes sustainable farming
                  practices and strengthens our food systems. Small-scale farms
                  often use regenerative agriculture methods that benefit soil
                  health and biodiversity.
                </p>
                <ul className="space-y-3 text-zinc-600">
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Resilient and direct supply chains
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Support for sustainable farming practices
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Preservation of agricultural land
                  </li>
                  <li className="flex items-start">
                    <span className="mr-2 text-green-500">✓</span>
                    Strengthening local food security
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* CTA Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 bg-black py-20 text-white">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-6 text-4xl font-black md:text-5xl">
            Start Supporting Local Dairy Farmers Today
          </h2>
          <p className="mx-auto mb-8 max-w-2xl text-lg text-zinc-300">
            Join the Milk Market community, be a part of the &ldquo;FREE
            MILK&rdquo; movement, and connect with local farmers for farm-fresh,
            sustainable raw dairy products.
          </p>
          <Link href="/marketplace">
            <button className={PRIMARYBUTTONCLASSNAMES}>FREE MILK NOW!</button>
          </Link>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Signup Form Section */}
      {/* ================================================================================= */}
      <section
        id="signup"
        className="relative z-10 overflow-hidden border-b-2 border-black bg-grid-pattern py-20"
      >
        {/* Plus Pattern Background */}
        <PlusPattern />

        {/* Floating Milk Cartons */}
        <div className="animate-float-slow pointer-events-none absolute left-[10%] top-[15%] opacity-[0.08]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={105}
            height={105}
            className="h-26 w-26"
          />
        </div>
        <div className="animate-float-fast pointer-events-none absolute right-[12%] top-[20%] opacity-[0.05]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={85}
            height={85}
            className="h-21 w-21"
          />
        </div>
        <div className="animate-float-medium pointer-events-none absolute bottom-[18%] left-[15%] opacity-[0.06]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={110}
            height={110}
            className="h-28 w-28"
          />
        </div>
        <div className="animate-float-slow pointer-events-none absolute bottom-[10%] right-[20%] opacity-[0.07]">
          <Image
            src="/milk-carton.png"
            alt="Milk Carton"
            width={95}
            height={95}
            className="h-24 w-24"
          />
        </div>

        <div className="relative z-10 mx-auto max-w-2xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-6 text-4xl font-black md:text-5xl">
            Stay Updated on Farms, Food, and Freedom
          </h2>
          <p className="mb-8 text-lg text-zinc-600">
            Be in the know on new product listings, community events, and the
            rearchitecting of our broken food system
          </p>

          <div className="rounded-lg border-2 border-black bg-white p-8 text-left shadow-neo">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="mb-2 block text-base font-bold">
                  How would you like us to reach you?
                </label>
                <div className="flex gap-6">
                  <label className="flex cursor-pointer items-center">
                    <input
                      type="radio"
                      name="contactType"
                      value="email"
                      checked={contactType === "email"}
                      onChange={() => setContactType("email")}
                      className="mr-2 accent-black"
                    />
                    Email
                  </label>
                  <label className="flex cursor-pointer items-center">
                    <input
                      type="radio"
                      name="contactType"
                      value="nostr"
                      checked={contactType === "nostr"}
                      onChange={() => setContactType("nostr")}
                      className="mr-2 accent-black"
                    />
                    Nostr
                  </label>
                </div>
              </div>

              <div>
                <label
                  htmlFor="contact"
                  className="mb-2 block text-base font-bold"
                >
                  {contactType === "email"
                    ? "Email Address"
                    : "Nostr Public Key (npub)"}
                </label>
                <input
                  id="contact"
                  type="text"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder={
                    contactType === "email" ? "your@email.com" : "npub..."
                  }
                  className="w-full rounded-lg border-2 border-black p-3 shadow-neo focus:outline-none"
                  style={{ backgroundColor: "#f0f0f0" }}
                />
              </div>

              <button
                type="submit"
                disabled={!isValidContact || isSubmitting}
                className={`${BLACKBUTTONCLASSNAMES} w-full`}
              >
                {isSubmitting ? "Submitting..." : "Submit"}
              </button>
            </form>

            {submitMessage && (
              <div
                className={`mt-4 rounded-lg p-4 ${
                  submitMessage.type === "success"
                    ? "border border-green-200 bg-green-100 text-green-800"
                    : "border border-red-200 bg-red-100 text-red-800"
                }`}
              >
                <p className="flex items-center space-x-2">
                  <span>{submitMessage.type === "success" ? "✅" : "❌"}</span>
                  <span>{submitMessage.text}</span>
                </p>
              </div>
            )}

            <div className="mt-6 text-sm text-zinc-500">
              <p className="flex items-center justify-center space-x-1">
                <span>🔒</span>
                <span>
                  Your contact info stays private and will never be shared
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Get In Touch Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 w-full border-b-2 border-black bg-zinc-50 py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-8 text-4xl font-black md:text-5xl">Get In Touch</h2>
          <div className="mx-auto max-w-2xl rounded-lg border-2 border-black bg-white p-8 shadow-neo">
            <p className="mb-6 text-center text-lg text-zinc-700">
              Have questions about Milk Market? Reach out to us:
            </p>
            <div className="space-y-4 text-left">
              <div className="flex items-center space-x-3">
                <span className="text-2xl">📧</span>
                <a
                  href="mailto:freemilk@milk.market"
                  className="break-all font-medium text-black underline"
                >
                  Email: freemilk@milk.market
                </a>
              </div>
              <div className="flex items-center space-x-3">
                <span className="text-2xl">⚡️</span>
                <a
                  href="https://njump.me/milkmarket@milk.market"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-medium text-black underline"
                >
                  Nostr: milkmarket@milk.market
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Final CTA Section */}
      {/* ================================================================================= */}
      <section className="relative z-10 bg-black py-20 text-white">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-6 text-4xl font-black md:text-5xl">
            Ready to Support Local Farmers?
          </h2>
          <p className="mx-auto mb-8 max-w-2xl text-lg text-zinc-300">
            Join those connecting with local dairy producers for farm-fresh,
            sustainable nutrition!
          </p>
          <Link href="/marketplace">
            <button
              className={`${PRIMARYBUTTONCLASSNAMES} mx-auto flex items-center gap-2`}
            >
              Find Local Dairies 💡
            </button>
          </Link>
        </div>
      </section>

      {/* ================================================================================= */}
      {/* Footer */}
      {/* ================================================================================= */}
      <footer className="relative z-10 bg-gray-900 py-16 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {/* Trust Signals */}
          <div className="mb-12 grid gap-8 text-center md:grid-cols-3">
            <div>
              <h4 className="mb-2 text-lg font-bold">🛡️ Private</h4>
              <p className="text-zinc-400">
                All Information is Encrypted and Private
              </p>
            </div>
            <div>
              <h4 className="mb-2 text-lg font-bold">⛔️ Permissionless</h4>
              <p className="text-zinc-400">
                No Central Server Can Shut Us Down
              </p>
            </div>
            <div>
              <h4 className="mb-2 text-lg font-bold">🤝 Peer to Peer</h4>
              <p className="text-zinc-400">
                Purchase Directly From Your Local Farmer
              </p>
            </div>
          </div>

          {/* Anti-Censorship Pledge */}
          <div className="mx-auto mb-12 max-w-4xl rounded-lg border-2 border-primary-yellow bg-zinc-900 p-8">
            <h3 className="mb-6 text-center text-2xl font-bold">
              Anti-Censorship Pledge
            </h3>
            <p className="mb-4 text-lg font-bold">We Will Never:</p>
            <ul className="space-y-2 text-zinc-300">
              <li className="flex items-start">
                <span className="mr-2 text-red-400">✗</span>
                Share user data with regulators
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-red-400">✗</span>
                Remove listings that deal with dairy
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-red-400">✗</span>
                Freeze funds, transactions, or communications
              </li>
            </ul>
          </div>

          {/* Final Message & Links */}
          <div className="border-t border-zinc-700 pt-8 text-center">
            <div className="mb-6 flex items-center justify-center space-x-2">
              <Image
                src="/milk-market.png"
                alt="Milk Market"
                className="h-8 w-8"
              />
              <span className="text-xl font-bold">Milk Market</span>
            </div>
            <p className="mb-6 text-2xl font-bold">
              The Milk Revolution Won&apos;t Be Pasteurized. Join Us.
            </p>
            <div className="mb-6 flex items-center justify-center gap-6">
              <Link href="/faq" className="font-bold hover:underline">
                FAQ
              </Link>
              <Link href="/terms" className="font-bold hover:underline">
                Terms
              </Link>
              <Link href="/privacy" className="font-bold hover:underline">
                Privacy
              </Link>
            </div>
            <div className="mb-6 flex flex-wrap items-center justify-center gap-6">
              <a
                href="https://github.com/shopstr-eng/milk-market"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-transform hover:scale-110"
              >
                <Image
                  src="/github-mark-white.png"
                  alt="GitHub"
                  width={24}
                  height={24}
                />
              </a>
              <a
                href="https://x.com/milkmarketmedia"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-transform hover:scale-110"
              >
                <Image src="/x-logo-white.png" alt="X" width={24} height={24} />
              </a>
              <a
                href="https://njump.me/milkmarket@milk.market"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-transform hover:scale-110"
              >
                <Image
                  src="/nostr-icon-white-transparent-256x256.png"
                  alt="Nostr"
                  width={32}
                  height={32}
                />
              </a>
              <a
                href="https://www.youtube.com/@milkmarketmedia"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-transform hover:scale-110"
              >
                <Image
                  src="/youtube-icon.png"
                  alt="YouTube"
                  width={24}
                  height={24}
                />
              </a>
              <a
                href="https://www.instagram.com/milkmarketmedia/"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-transform hover:scale-110"
              >
                <Image
                  src="/instagram-icon.png"
                  alt="Instagram"
                  width={24}
                  height={24}
                />
              </a>
              <a
                href="https://www.tiktok.com/@milkmarket.media"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-transform hover:scale-110"
              >
                <Image
                  src="/tiktok-icon.png"
                  alt="TikTok"
                  width={24}
                  height={24}
                />
              </a>
            </div>
            <p className="text-zinc-500">© 2025 Milk Market LLC</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
