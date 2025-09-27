import { useState, useContext, useEffect } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  Button,
  Image,
  Input,
  Card,
  CardBody,
  Radio,
  RadioGroup,
} from "@nextui-org/react";
import { ArrowUpRightIcon, Bars3Icon } from "@heroicons/react/24/outline";
import { BLACKBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";

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

  return (
    <div className="relative min-h-screen w-full max-w-full overflow-x-hidden bg-light-bg text-light-text">
      {/* Animated Ink Splatters Background */}
      <div className="pointer-events-none fixed inset-0 z-0">
        {/* Splatter 1 - Multiple connected circles */}
        <div
          className="absolute left-10 top-20 animate-bounce opacity-60"
          style={{ animationDelay: "0s", animationDuration: "3s" }}
        >
          <div className="relative">
            <div className="h-12 w-12 rounded-full bg-dark-bg"></div>
            <div className="absolute -right-2 -top-1 h-6 w-8 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-2 left-2 h-4 w-6 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-1 top-3 h-3 w-3 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 2 - Elongated main shape with droplets */}
        <div
          className="absolute right-20 top-40 animate-bounce opacity-60"
          style={{ animationDelay: "1s", animationDuration: "4s" }}
        >
          <div className="relative">
            <div className="h-8 w-12 rounded-full bg-dark-bg"></div>
            <div className="absolute -right-3 top-1 h-5 w-5 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-1 left-8 h-3 w-4 rounded-full bg-dark-bg"></div>
            <div className="absolute -top-2 left-3 h-2 w-2 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 3 - Large main blob with trailing droplets */}
        <div
          className="absolute bottom-60 left-1/4 animate-bounce opacity-60"
          style={{ animationDelay: "2s", animationDuration: "5s" }}
        >
          <div className="relative">
            <div className="h-16 w-20 rounded-full bg-dark-bg"></div>
            <div className="absolute -right-4 top-2 h-8 w-10 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-3 left-12 h-6 w-8 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-2 top-8 h-4 w-5 rounded-full bg-dark-bg"></div>
            <div className="absolute -top-2 right-2 h-3 w-3 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 4 - Vertical drip pattern */}
        <div
          className="absolute right-10 top-1/2 animate-bounce opacity-60"
          style={{ animationDelay: "0.5s", animationDuration: "3.5s" }}
        >
          <div className="relative">
            <div className="h-10 w-10 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-4 left-3 h-8 w-6 rounded-full bg-dark-bg"></div>
            <div className="absolute -right-2 top-2 h-5 w-7 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-1 -top-1 h-3 w-4 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 5 - Asymmetric cluster */}
        <div
          className="absolute bottom-40 right-1/3 animate-bounce opacity-60"
          style={{ animationDelay: "1.5s", animationDuration: "4.5s" }}
        >
          <div className="relative">
            <div className="h-14 w-16 rounded-full bg-dark-bg"></div>
            <div className="absolute -right-5 -top-2 h-9 w-11 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-4 left-4 h-7 w-9 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-3 top-6 h-4 w-6 rounded-full bg-dark-bg"></div>
            <div className="absolute right-1 top-1 h-2 w-3 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 6 - Small scattered droplets */}
        <div
          className="absolute left-1/2 top-80 animate-bounce opacity-60"
          style={{ animationDelay: "3s", animationDuration: "6s" }}
        >
          <div className="relative">
            <div className="h-6 w-8 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-1 -right-2 h-4 w-5 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-2 -top-1 h-3 w-4 rounded-full bg-dark-bg"></div>
            <div className="absolute right-1 top-3 h-2 w-2 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 7 - Large organic shape with satellites */}
        <div
          className="absolute bottom-20 left-20 animate-bounce opacity-60"
          style={{ animationDelay: "2.5s", animationDuration: "5.5s" }}
        >
          <div className="relative">
            <div className="h-20 w-24 rounded-full bg-dark-bg"></div>
            <div className="w-15 absolute -right-6 top-4 h-12 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-5 left-8 h-10 w-12 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-4 top-10 h-6 w-8 rounded-full bg-dark-bg"></div>
            <div className="absolute -top-3 right-2 h-4 w-5 rounded-full bg-dark-bg"></div>
            <div className="absolute bottom-2 left-16 h-3 w-4 rounded-full bg-dark-bg"></div>
          </div>
        </div>

        {/* Splatter 8 - Complex multi-directional splatter */}
        <div
          className="absolute right-1/2 top-60 animate-bounce opacity-60"
          style={{ animationDelay: "4s", animationDuration: "7s" }}
        >
          <div className="relative">
            <div className="h-12 w-14 rounded-full bg-dark-bg"></div>
            <div className="absolute -right-4 -top-2 h-8 w-10 rounded-full bg-dark-bg"></div>
            <div className="absolute -bottom-3 left-3 h-7 w-9 rounded-full bg-dark-bg"></div>
            <div className="absolute -left-3 top-4 h-5 w-6 rounded-full bg-dark-bg"></div>
            <div className="absolute bottom-1 right-1 h-3 w-4 rounded-full bg-dark-bg"></div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="relative z-20 flex items-center justify-between p-4 md:p-6 md:px-12">
        <div className="flex items-center space-x-2">
          <Image
            src="/milk-market.png"
            alt="Milk Market"
            width={32}
            height={32}
            className="h-8 w-8"
          />
          <div className="flex flex-col md:flex-row md:space-x-1">
            <span className="text-xl font-bold">Milk</span>
            <span className="text-xl font-bold">Market</span>
          </div>
        </div>

        {/* Desktop Navigation */}
        <div className="hidden md:flex md:items-center md:space-x-4">
          <Link href="/producers" className="w-auto">
            <Button
              color="default"
              variant="ghost"
              className="w-auto text-light-text hover:text-gray-600"
            >
              Sell Your Dairy 🚜
            </Button>
          </Link>
          <Button
            onClick={() => {
              const signupSection = document.getElementById("signup");
              if (signupSection) {
                signupSection.scrollIntoView({ behavior: "smooth" });
              }
            }}
            color="default"
            variant="solid"
            className={`w-auto ${BLACKBUTTONCLASSNAMES}`}
          >
            Get Updates 📨
          </Button>
          <Link href="/marketplace" className="w-auto">
            <Button
              color="default"
              variant="solid"
              className="w-auto bg-gradient-to-tr from-yellow-700 via-yellow-500 to-yellow-700 text-light-text shadow-lg"
            >
              Browse Milk Market 🥛
            </Button>
          </Link>
        </div>

        {/* Mobile Navigation */}
        <div className="relative md:hidden">
          <Button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="bg-transparent"
          >
            <Bars3Icon className="h-6 w-6 text-yellow-600" />
          </Button>
          {isMobileMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-48 rounded-md border border-gray-200 bg-white shadow-lg">
              <div className="py-1">
                <Link href="/producers" className="block">
                  <Button
                    className="w-full bg-transparent px-4 py-2 text-left text-sm font-bold text-light-text hover:bg-gray-50"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    Sell Your Dairy 🚜
                  </Button>
                </Link>
                <Button
                  className="w-full bg-transparent px-4 py-2 text-left text-sm font-bold text-light-text hover:bg-gray-50"
                  onClick={() => {
                    const signupSection = document.getElementById("signup");
                    if (signupSection) {
                      signupSection.scrollIntoView({ behavior: "smooth" });
                    }
                    setIsMobileMenuOpen(false);
                  }}
                >
                  Get Updates 📨
                </Button>
                <Link href="/marketplace" className="block">
                  <Button
                    className="w-full bg-transparent px-4 py-2 text-left text-sm font-bold text-yellow-600 hover:bg-gray-50"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    Browse Milk Market 🥛
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative z-10 px-4 pb-32 pt-8 sm:px-6 sm:pt-20 lg:px-8">
        <div className="mx-auto max-w-6xl text-center">
          <div className="animate-fadeInUp">
            <div className="mb-8 flex justify-center space-x-4">
              <span className="animate-float text-4xl">🐄🐐</span>
              <span
                className="animate-float text-4xl"
                style={{ animationDelay: "0.5s" }}
              >
                🥛
              </span>
              <span
                className="animate-float text-4xl"
                style={{ animationDelay: "1s" }}
              >
                🚜
              </span>
            </div>

            <h1 className="mb-8 text-5xl font-black leading-tight md:text-7xl">
              Raw Dairy Direct from <br />
              <span className="inline-block -rotate-1 transform bg-dark-bg px-4 py-2 text-dark-text">
                Local Farmers
              </span>
            </h1>

            <p className="mx-auto mb-6 max-w-3xl text-xl text-gray-600 md:text-2xl">
              Connect with trusted local dairy farmers and access farm-fresh,
              raw milk and dairy products. Our marketplace, built with
              sovereignty and community in mind, ensures secure transactions
              while directly supporting farmers in your area.
            </p>

            <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <Link href="/marketplace">
                <Button
                  color="default"
                  variant="solid"
                  size="lg"
                  className="transform rounded-xl bg-gradient-to-tr from-yellow-700 via-yellow-500 to-yellow-700 px-6 py-3 text-xl text-light-text shadow-xl transition-all hover:scale-105"
                >
                  Discover Local Dairy 🥛
                </Button>
              </Link>
              <Link href="/producers">
                <Button
                  color="default"
                  variant="solid"
                  size="lg"
                  className="hover:bg-white-800 transform rounded-xl border-2 border-light-text bg-light-bg px-6 py-3 text-xl text-light-text shadow-xl transition-all hover:scale-105"
                >
                  Start Selling Today 🚜
                </Button>
              </Link>
              <Button
                onClick={() => {
                  const signupSection = document.getElementById("signup");
                  if (signupSection) {
                    signupSection.scrollIntoView({ behavior: "smooth" });
                  }
                }}
                color="default"
                variant="solid"
                size="lg"
                className="transform rounded-xl bg-dark-bg px-6 py-3 text-xl text-dark-text shadow-xl transition-all hover:scale-105 hover:bg-gray-800"
              >
                Stay Milky 📨
              </Button>
              <Link href="/faq">
                <Button
                  color="default"
                  variant="solid"
                  size="lg"
                  className="hover:bg-white-800 transform rounded-xl border-2 border-light-text bg-light-bg px-6 py-3 text-xl text-light-text shadow-xl transition-all hover:scale-105"
                >
                  Learn More 🙋
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="relative z-10 bg-light-bg py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-bold md:text-5xl">
              Why Choose Milk Market for Raw Dairy?
            </h2>
            <p className="text-xl text-gray-600">
              Connecting consumers with trusted dairy producers
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-3">
            <Card className="hover-lift border-gray-100 bg-light-bg">
              <CardBody className="p-8 text-center">
                <span className="mb-4 block text-4xl">🚜</span>
                <h3 className="mb-4 text-xl font-semibold text-light-text">
                  Direct from Farm
                </h3>
                <p className="text-gray-600">
                  Skip the grocery store and get farm-fresh raw milk, cheese,
                  and dairy products directly from local farmers. Support
                  farmers while enjoying the freshest dairy available in your
                  area.
                </p>
              </CardBody>
            </Card>

            <Card className="hover-lift border-gray-100 bg-light-bg">
              <CardBody className="p-8 text-center">
                <span className="mb-4 block text-4xl">🤝</span>
                <h3 className="mb-4 text-xl font-semibold text-light-text">
                  Peer-to-Peer Payments
                </h3>
                <p className="text-gray-600">
                  Pay your farmer directly and securely with Bitcoin, cash, or
                  other digital cash methods. Our permissionless platform
                  ensures your transactions are private and secure without
                  intermediaries, with fees at your control.
                </p>
              </CardBody>
            </Card>

            <Card className="hover-lift border-gray-100 bg-light-bg">
              <CardBody className="p-8 text-center">
                <span className="mb-4 block text-4xl">🫂</span>
                <h3 className="mb-4 text-xl font-semibold text-light-text">
                  Community Focused
                </h3>
                <p className="text-gray-600">
                  Build relationships with local dairy farmers and support your
                  community&apos;s agricultural economy. Access farm-fresh
                  products while contributing to sustainable local food systems.
                </p>
              </CardBody>
            </Card>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="relative z-10 bg-gray-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-bold md:text-5xl">
              How Milk Market Works
            </h2>
            <p className="text-xl text-gray-600">
              Simple steps to get farm-fresh raw dairy
            </p>
          </div>

          <div className="grid gap-16 lg:grid-cols-2">
            {/* Producers */}
            <div>
              <div className="mb-8 flex items-center">
                <span className="mr-4 text-3xl">🚜</span>
                <h3 className="text-3xl font-bold">Producers</h3>
              </div>

              <div className="space-y-6">
                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-dark-bg font-bold text-dark-text">
                    1
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-semibold">
                      List Your Milk
                    </h4>
                    <p className="text-gray-600">
                      Add products to the marketplace with a few clicks
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-dark-bg font-bold text-dark-text">
                    2
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-semibold">Set Terms</h4>
                    <p className="text-gray-600">
                      Define price, delivery type, and preferred payment methods
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-dark-bg font-bold text-dark-text">
                    3
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-semibold">
                      Grow Your Business
                    </h4>
                    <p className="text-gray-600">
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
                <h3 className="text-3xl font-bold">Drinkers</h3>
              </div>

              <div className="space-y-6">
                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-dark-bg font-bold text-dark-text">
                    1
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-semibold">
                      Local-first Connections
                    </h4>
                    <p className="text-gray-600">
                      Find and support farmers in your city, state, and country
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-dark-bg font-bold text-dark-text">
                    2
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-semibold">
                      Secure Checkout
                    </h4>
                    <p className="text-gray-600">
                      Choose Bitcoin, cash, or other digital cash options
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-dark-bg font-bold text-dark-text">
                    3
                  </div>
                  <div>
                    <h4 className="mb-2 text-xl font-semibold">
                      From Farm to Table
                    </h4>
                    <p className="text-gray-600">
                      Schedule pickups and deliveries directly with producers
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="relative z-10 bg-gray-50 py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="mb-8 text-3xl font-bold text-light-text">
              Explore Milk Market
            </h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Link
                href="/marketplace"
                className="group rounded-lg border border-gray-200 bg-white p-4 transition-all hover:shadow-md"
              >
                <span className="block text-2xl transition-transform group-hover:scale-110">
                  🥛
                </span>
                <span className="block text-sm font-medium text-light-text">
                  Browse Products
                </span>
              </Link>
              <Link
                href="/producers"
                className="group rounded-lg border border-gray-200 bg-white p-4 transition-all hover:shadow-md"
              >
                <span className="block text-2xl transition-transform group-hover:scale-110">
                  🚜
                </span>
                <span className="block text-sm font-medium text-light-text">
                  Start Selling
                </span>
              </Link>
              <Link
                href="/communities"
                className="group rounded-lg border border-gray-200 bg-white p-4 transition-all hover:shadow-md"
              >
                <span className="block text-2xl transition-transform group-hover:scale-110">
                  🫂
                </span>
                <span className="block text-sm font-medium text-light-text">
                  View Communities
                </span>
              </Link>
              <Link
                href="/faq"
                className="group rounded-lg border border-gray-200 bg-white p-4 transition-all hover:shadow-md"
              >
                <span className="block text-2xl transition-transform group-hover:scale-110">
                  ❓
                </span>
                <span className="block text-sm font-medium text-light-text">
                  FAQ
                </span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="relative z-10 bg-light-bg py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-bold md:text-5xl">
              Benefits of Local Raw Dairy
            </h2>
            <p className="text-xl text-gray-600">
              Superior nutrition and community impact
            </p>
          </div>

          <div className="mx-auto max-w-6xl">
            <div className="grid gap-16 lg:grid-cols-2">
              <div>
                <Card className="h-full border-gray-100 bg-light-bg">
                  <CardBody className="p-8">
                    <h3 className="mb-4 text-2xl font-semibold text-light-text">
                      Nutritional Excellence
                    </h3>
                    <p className="mb-6 text-gray-600">
                      Farm-fresh, minimally processed dairy from grass-fed
                      animals provides superior nutrition. Raw milk contains
                      beneficial enzymes, probiotics, and vitamins that are
                      often lost in commercial processing.
                    </p>
                    <ul className="space-y-3 text-gray-600">
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
                  </CardBody>
                </Card>
              </div>

              <div>
                <Card className="h-full border-gray-100 bg-light-bg">
                  <CardBody className="p-8">
                    <h3 className="mb-4 text-2xl font-semibold text-light-text">
                      Community Impact
                    </h3>
                    <p className="mb-6 text-gray-600">
                      Supporting local dairy farmers promotes sustainable
                      farming practices and strengthens our food systems.
                      Small-scale farms often use regenerative agriculture
                      methods that benefit soil health and biodiversity.
                    </p>
                    <ul className="space-y-3 text-gray-600">
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
                  </CardBody>
                </Card>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="relative z-10 bg-dark-bg py-20 text-dark-text">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-6 text-4xl font-bold md:text-5xl">
            Start Supporting Local Dairy Farmers Today
          </h2>
          <p className="mx-auto mb-8 max-w-2xl text-xl text-gray-300">
            Join the Milk Market community, be a part of the &ldquo;FREE
            MILK&rdquo; movement, and connect with local farmers for farm-fresh,
            sustainable raw dairy products. Your support helps maintain
            ancestral traditions while providing your family with the highest
            quality nutrition.
          </p>
          <Link href="/marketplace">
            <Button
              color="default"
              variant="solid"
              size="lg"
              className="bg-gradient-to-tr from-yellow-700 via-yellow-500 to-yellow-700 px-8 py-3 text-xl text-light-text shadow-xl"
            >
              FREE MILK NOW 🥛
            </Button>
          </Link>
        </div>
      </section>

      {/* Signup Form */}
      <section
        id="signup"
        className="relative z-10 bg-gradient-to-b from-gray-50 to-white py-20"
      >
        <div className="mx-auto max-w-2xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-6 text-4xl font-bold md:text-5xl">Stay Milky</h2>
          <p className="mb-8 text-xl text-gray-600">
            Be the first to know when new products are listed and when updates
            are released
          </p>

          <Card className="border-gray-200 bg-light-bg shadow-xl">
            <CardBody className="p-8">
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="text-left text-light-text">
                  <label className="mb-4 block text-base font-medium">
                    How would you like us to reach you?
                  </label>
                  <RadioGroup
                    value={contactType}
                    onValueChange={(value: string) => {
                      setContactType(value as "email" | "nostr");
                      setContact("");
                    }}
                    orientation="horizontal"
                    classNames={{
                      wrapper: "gap-6",
                    }}
                  >
                    <Radio
                      value="email"
                      classNames={{
                        label: "text-light-text",
                      }}
                    >
                      📧 Email address
                    </Radio>
                    <Radio
                      value="nostr"
                      classNames={{
                        label: "text-light-text",
                      }}
                    >
                      ⚡ Nostr npub
                    </Radio>
                  </RadioGroup>
                </div>

                <div className="text-left text-light-text">
                  <label
                    htmlFor="contact"
                    className="mb-2 block text-base font-medium"
                  >
                    {contactType === "email"
                      ? "Email Address"
                      : "Nostr Public Key (npub)"}
                  </label>
                  <Input
                    id="contact"
                    type="text"
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    placeholder={
                      contactType === "email" ? "your@email.com" : "npub..."
                    }
                    size="lg"
                    variant="bordered"
                    classNames={{
                      input: "text-lg",
                      inputWrapper: "border-gray-300 focus-within:border-black",
                    }}
                  />
                  {contactType === "nostr" && (
                    <p className="mt-2 text-sm text-gray-500">
                      Your Nostr public key ensures more secure communication
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  isDisabled={!isValidContact || isSubmitting}
                  isLoading={isSubmitting}
                  color="default"
                  variant="solid"
                  size="lg"
                  className="w-full bg-dark-bg px-6 py-3 text-lg text-dark-text"
                >
                  {isSubmitting ? "Submitting..." : "Submit"}
                </Button>
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
                    <span>
                      {submitMessage.type === "success" ? "✅" : "❌"}
                    </span>
                    <span>{submitMessage.text}</span>
                  </p>
                </div>
              )}

              <div className="mt-6 text-sm text-gray-500">
                <p className="flex items-center justify-center space-x-1">
                  <span>🔒</span>
                  <span>
                    Your contact info stays private and will never be shared
                  </span>
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* Contact Section */}
      <section className="relative z-10 w-full bg-gray-50 py-16">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-8 text-3xl font-bold md:text-4xl">Get In Touch</h2>
          <Card className="mx-auto max-w-2xl bg-light-bg shadow-lg">
            <CardBody className="p-4 sm:p-8">
              <p className="mb-6 text-center text-base text-gray-700 sm:text-lg">
                Have questions about Milk Market? Reach out to us:
              </p>
              <div className="space-y-4">
                <div className="flex flex-col items-center justify-center space-y-2 sm:flex-row sm:space-x-3 sm:space-y-0">
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl">📧</span>
                    <span className="font-semibold text-gray-800">Email:</span>
                  </div>
                  <a
                    href="mailto:freemilk@milk.market"
                    className="break-words font-medium text-light-text underline transition-colors hover:text-gray-600"
                  >
                    freemilk@milk.market
                  </a>
                </div>
                <div className="flex flex-col items-center justify-center space-y-2 sm:flex-row sm:space-x-3 sm:space-y-0">
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl">⚡</span>
                    <span className="font-semibold text-gray-800">Nostr:</span>
                  </div>
                  <a
                    href="https://njump.me/milkmarket@milk.market"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-words font-mono font-medium text-light-text underline transition-colors hover:text-gray-600"
                  >
                    milkmarket@milk.market
                  </a>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* Final CTAs */}
      <section className="relative z-10 bg-dark-bg py-20 text-dark-text">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-bold md:text-5xl">
              Ready to Support Local Farmers?
            </h2>
            <p className="mb-6 text-xl text-gray-300">
              Join those connecting with local dairy producers for farm-fresh,
              sustainable nutrition!
            </p>
            <Link href="/marketplace">
              <Button
                color="default"
                variant="solid"
                className="w-auto bg-gradient-to-tr from-yellow-700 via-yellow-500 to-yellow-700 text-light-text shadow-lg"
              >
                Find Local Dairies 🥛
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 bg-gray-900 py-16 text-dark-text">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {/* Trust Signals */}
          <div className="mb-12 grid gap-8 md:grid-cols-3">
            <div className="text-center">
              <span className="mb-3 block text-3xl">🛡️</span>
              <h4 className="mb-2 text-lg font-semibold">Private</h4>
              <p className="text-gray-400">
                All Information is Encrypted and Private
              </p>
            </div>

            <div className="text-center">
              <span className="mb-3 block text-3xl">🔒</span>
              <h4 className="mb-2 text-lg font-semibold">Permissionless</h4>
              <p className="text-gray-400">
                No Central Server Can Shut Us Down
              </p>
            </div>

            <div className="text-center">
              <span className="mb-3 block text-3xl">🤝</span>
              <h4 className="mb-2 text-lg font-semibold">Peer to Peer</h4>
              <p className="text-gray-400">
                Purchase Directly From Your Local Farmer
              </p>
            </div>
          </div>

          {/* Anti-Censorship Pledge */}
          <Card className="mb-12 border-gray-700 bg-gray-800">
            <CardBody className="p-8">
              <h3 className="mb-6 text-center text-2xl font-bold text-dark-text">
                Anti-Censorship Pledge
              </h3>
              <p className="mb-4 text-lg font-semibold text-dark-text">
                We Will Never:
              </p>
              <ul className="space-y-2 text-gray-300">
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
            </CardBody>
          </Card>

          {/* Final Message */}
          <div className="border-t border-gray-700 pt-8">
            <div className="mb-6 flex flex-col items-center justify-between md:flex-row">
              <div className="mb-4 flex flex-col items-center gap-4 md:mb-0">
                <div className="flex items-center gap-8">
                  <Link
                    href="/faq"
                    className="flex items-center gap-1 text-dark-text transition-colors hover:text-gray-300"
                  >
                    FAQ
                    <ArrowUpRightIcon className="h-3 w-3" />
                  </Link>
                  <Link
                    href="/terms"
                    className="flex items-center gap-1 text-dark-text transition-colors hover:text-gray-300"
                  >
                    Terms
                    <ArrowUpRightIcon className="h-3 w-3" />
                  </Link>
                  <Link
                    href="/privacy"
                    className="flex items-center gap-1 text-dark-text transition-colors hover:text-gray-300"
                  >
                    Privacy
                    <ArrowUpRightIcon className="h-3 w-3" />
                  </Link>
                </div>
                <p className="text-dark-text">© 2025 Shopstr Markets Inc.</p>
              </div>
              <div className="flex h-auto flex-shrink-0 items-center gap-6">
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
                  href="https://x.com/milkmarketmedia"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-transform hover:scale-110"
                >
                  <Image
                    src="/x-logo-white.png"
                    alt="X (formerly Twitter)"
                    width={24}
                    height={24}
                  />
                </a>
                <a
                  href="https://www.youtube.com/@milk.market"
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
                  href="https://www.instagram.com/milkmarket.media/"
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
            </div>
            <div className="text-center">
              <div className="mb-4 flex items-center justify-center space-x-2">
                <Image
                  src="/milk-market.png"
                  alt="Milk Market"
                  className="h-8 w-8"
                />
                <span className="text-xl font-bold">Milk Market</span>
              </div>
              <p className="mb-4 text-2xl font-bold">
                The Milk Revolution Won&apos;t Be Pasteurized. Join Us.
              </p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
