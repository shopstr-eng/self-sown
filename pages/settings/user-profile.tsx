import React from "react";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import UserProfileForm from "@/components/settings/user-profile-form";

const UserProfilePage = () => {
  return (
    <div className="min-h-screen bg-white pt-8 md:pb-20 md:pt-12">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 md:px-8">
        <SettingsBreadCrumbs />
        <UserProfileForm />
      </div>
    </div>
  );
};

export default UserProfilePage;
