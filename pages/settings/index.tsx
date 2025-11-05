import { useRouter } from "next/router";
import {
  BuildingStorefrontIcon,
  Cog6ToothIcon,
  UserIcon,
  UserGroupIcon,
  ArrowRightStartOnRectangleIcon,
} from "@heroicons/react/24/outline";
import { LogOut } from "@/utils/nostr/nostr-helper-functions";

const SettingsPage = () => {
  const router = useRouter();

  const settingsItems = [
    {
      id: "shop-profile",
      title: "Shop Profile",
      description: "Edit your shop profile",
      icon: BuildingStorefrontIcon,
      iconBg: "bg-slate-600",
      route: "/settings/shop-profile",
    },
    {
      id: "user-profile",
      title: "User Profile",
      description: "Edit your user profile",
      icon: UserIcon,
      iconBg: "bg-slate-600",
      route: "/settings/user-profile",
    },
    {
      id: "community",
      title: "Community Management",
      description: "Create and manage your seller community",
      icon: UserGroupIcon,
      iconBg: "bg-slate-600",
      route: "/settings/community",
    },
    {
      id: "preferences",
      title: "Preferences",
      description: "Change your mints, relays, media servers, and more",
      icon: Cog6ToothIcon,
      iconBg: "bg-slate-600",
      route: "/settings/preferences",
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-white pb-20 pt-24">
      <div className="mx-auto w-full px-4 lg:w-1/2 xl:w-2/5">
        <h1 className="mb-6 text-4xl font-bold">Settings</h1>

        {/* Account Section */}
        <div className="mb-10">
          <h2 className="mb-3 text-xl font-bold">Account</h2>
          <div className="space-y-3">
            {settingsItems.map((item) => {
              const IconComponent = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => router.push(item.route)}
                  className="group w-full transform cursor-pointer rounded-xl border-3 border-black bg-primary-blue p-4 transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`${item.iconBg} rounded-lg border-2 border-black/20 p-2.5`}
                    >
                      <IconComponent className="h-5 w-5 text-white" />
                    </div>
                    <div className="flex-1 text-left">
                      <h3 className="text-base font-bold text-white group-hover:text-gray-100">
                        {item.title}
                      </h3>
                      <p className="text-sm text-gray-300 group-hover:text-gray-200">
                        {item.description}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Log out Section */}
        <div>
          <h2 className="mb-3 text-xl font-bold">Log out</h2>
          <button
            onClick={() => {
              LogOut();
              router.push("/marketplace");
            }}
            className="group w-full transform cursor-pointer rounded-xl border-3 border-black bg-primary-blue p-4 transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
          >
            <div className="flex items-center gap-3">
              <div className="rounded-lg border-2 border-black/20 bg-red-400 p-2.5">
                <ArrowRightStartOnRectangleIcon className="h-5 w-5 text-white" />
              </div>
              <div className="flex-1 text-left">
                <h3 className="text-base font-bold text-white group-hover:text-gray-100">
                  Log out
                </h3>
                <p className="text-sm text-gray-300 group-hover:text-gray-200">
                  Log out of Milk Market
                </p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
