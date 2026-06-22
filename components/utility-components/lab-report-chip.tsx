import { useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Button,
} from "@heroui/react";
import {
  BeakerIcon,
  ArrowTopRightOnSquareIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import { sanitizeUrl } from "@braintree/sanitize-url";
import { LabReport } from "@/utils/parsers/product-parser-functions";

interface LabReportChipProps {
  labReports: LabReport[];
  className?: string;
}

export default function LabReportChip({
  labReports,
  className = "",
}: LabReportChipProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!labReports || labReports.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`shadow-neo inline-flex w-fit items-center gap-2 rounded-md border-2 border-black bg-white px-3 py-2 text-left transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${className}`}
      >
        <BeakerIcon className="text-primary-blue h-5 w-5 shrink-0" />
        <span className="text-sm font-semibold text-black">
          Third-Party Lab Test Results
        </span>
        <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0 text-gray-500" />
      </button>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        size="lg"
        scrollBehavior="inside"
        classNames={{
          wrapper: "shadow-neo",
          base: "border-2 border-black rounded-md",
          backdrop: "bg-black/20 backdrop-blur-sm",
          header: "border-b-2 border-black bg-white rounded-t-md text-black",
          body: "bg-white",
          closeButton: "hover:bg-black/5 active:bg-white/10",
        }}
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-2 text-black">
            <BeakerIcon className="text-primary-blue h-6 w-6" />
            Third-Party Lab Test Results
          </ModalHeader>
          <ModalBody className="pb-6">
            <p className="text-sm text-gray-600">
              This seller has provided independent third-party lab test results
              (Certificate of Analysis) for this product. View or download the
              files below to review the full details.
            </p>
            <div className="flex flex-col gap-3">
              {labReports.map((report, index) => (
                <div
                  key={`${report.url}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-md border-2 border-black bg-white p-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <DocumentTextIcon className="h-5 w-5 shrink-0 text-black" />
                    <span className="truncate text-sm font-medium text-black">
                      {report.name || `Lab Test Result ${index + 1}`}
                    </span>
                  </div>
                  <Button
                    as="a"
                    href={sanitizeUrl(report.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="sm"
                    className="shadow-neo shrink-0 rounded-md border-2 border-black bg-white text-sm font-semibold text-black"
                    startContent={
                      <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    }
                  >
                    View / Download
                  </Button>
                </div>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Results reflect laboratory analysis of submitted samples at the
              time of testing as reported by the testing laboratory.
            </p>
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
