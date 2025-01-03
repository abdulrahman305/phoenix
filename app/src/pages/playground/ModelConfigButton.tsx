import React, {
  Fragment,
  ReactNode,
  startTransition,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import debounce from "lodash/debounce";
import { css } from "@emotion/react";

import {
  Button,
  Dialog,
  DialogContainer,
  Flex,
  Icon,
  Icons,
  Item,
  Picker,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
} from "@arizeai/components";

import {
  AZURE_OPENAI_API_VERSIONS,
  ModelProviders,
} from "@phoenix/constants/generativeConstants";
import { useNotifySuccess } from "@phoenix/contexts";
import { usePlaygroundContext } from "@phoenix/contexts/PlaygroundContext";
import { usePreferencesContext } from "@phoenix/contexts/PreferencesContext";
import { PlaygroundInstance } from "@phoenix/store";

import { ModelConfigButtonDialogQuery } from "./__generated__/ModelConfigButtonDialogQuery.graphql";
import { InvocationParametersFormFields } from "./InvocationParametersFormFields";
import { ModelPicker } from "./ModelPicker";
import { ModelProviderPicker } from "./ModelProviderPicker";
import {
  convertInstanceToolsToProvider,
  convertMessageToolCallsToProvider,
} from "./playgroundUtils";
import { PlaygroundInstanceProps } from "./types";

const modelConfigFormCSS = css`
  display: flex;
  flex-direction: column;
  gap: var(--ac-global-dimension-size-200);
  .ac-field,
  .ac-dropdown,
  .ac-dropdown-button,
  .ac-slider {
    width: 100%;
  }
  // Makes the filled slider track blue
  .ac-slider-controls > .ac-slider-track:first-child::before {
    background: var(--ac-global-color-primary);
  }
  padding: var(--ac-global-dimension-size-200);
  overflow: auto;
`;

function AzureOpenAiModelConfigFormField({
  instance,
}: {
  instance: PlaygroundInstance;
}) {
  const updateModel = usePlaygroundContext((state) => state.updateModel);
  const modelConfigByProvider = usePreferencesContext(
    (state) => state.modelConfigByProvider
  );

  const updateModelConfig = useCallback(
    ({
      configKey,
      value,
    }: {
      configKey: keyof PlaygroundInstance["model"];
      value: string;
    }) => {
      updateModel({
        instanceId: instance.id,
        model: {
          ...instance.model,
          [configKey]: value,
        },
        modelConfigByProvider,
      });
    },
    [instance.id, instance.model, modelConfigByProvider, updateModel]
  );

  const debouncedUpdateModelName = useMemo(
    () =>
      debounce((value: string) => {
        updateModelConfig({
          configKey: "modelName",
          value,
        });
      }, 250),
    [updateModelConfig]
  );

  return (
    <>
      <TextField
        label="Deployment Name"
        defaultValue={instance.model.modelName ?? ""}
        onChange={(value) => {
          debouncedUpdateModelName(value);
        }}
      />
      <TextField
        label="Endpoint"
        value={instance.model.endpoint ?? ""}
        onChange={(value) => {
          updateModelConfig({
            configKey: "endpoint",
            value,
          });
        }}
      />
      <Picker
        label="API Version"
        selectedKey={instance.model.apiVersion ?? undefined}
        aria-label="api version picker"
        placeholder="Select an AzureOpenAI API Version"
        onSelectionChange={(key) => {
          if (typeof key === "string") {
            updateModelConfig({
              configKey: "apiVersion",
              value: key,
            });
          }
        }}
      >
        {AZURE_OPENAI_API_VERSIONS.map((version) => (
          <Item key={version}>{version}</Item>
        ))}
      </Picker>
    </>
  );
}

interface ModelConfigButtonProps extends PlaygroundInstanceProps {}
export function ModelConfigButton(props: ModelConfigButtonProps) {
  const [dialog, setDialog] = useState<ReactNode>(null);
  const instance = usePlaygroundContext((state) =>
    state.instances.find(
      (instance) => instance.id === props.playgroundInstanceId
    )
  );

  if (!instance) {
    throw new Error(
      `Playground instance ${props.playgroundInstanceId} not found`
    );
  }
  return (
    <Fragment>
      <Button
        variant="default"
        size="compact"
        onClick={() => {
          startTransition(() => {
            setDialog(<ModelConfigDialog {...props} />);
          });
        }}
      >
        <Flex direction="row" gap="size-100" alignItems="center">
          <Text weight="heavy">{ModelProviders[instance.model.provider]}</Text>
          <Text>{instance.model.modelName || "--"}</Text>
        </Flex>
      </Button>
      <DialogContainer
        type="slideOver"
        isDismissable
        onDismiss={() => {
          setDialog(null);
        }}
      >
        {dialog}
      </DialogContainer>
    </Fragment>
  );
}

interface ModelConfigDialogProps extends ModelConfigButtonProps {}
function ModelConfigDialog(props: ModelConfigDialogProps) {
  const instance = usePlaygroundContext((state) =>
    state.instances.find(
      (instance) => instance.id === props.playgroundInstanceId
    )
  );

  if (!instance) {
    throw new Error(
      `Playground instance ${props.playgroundInstanceId} not found`
    );
  }
  const setModelConfigForProvider = usePreferencesContext(
    (state) => state.setModelConfigForProvider
  );

  const notifySuccess = useNotifySuccess();
  const onSaveConfig = useCallback(() => {
    setModelConfigForProvider({
      provider: instance.model.provider,
      modelConfig: instance.model,
    });
    notifySuccess({
      title: "Model Configuration Saved",
      message: `${ModelProviders[instance.model.provider]} model configuration saved as default for later use.`,
      expireMs: 3000,
    });
  }, [instance.model, notifySuccess, setModelConfigForProvider]);
  return (
    <Dialog
      title="Model Configuration"
      size="M"
      extra={
        <TooltipTrigger delay={0} offset={5}>
          <Button
            size={"compact"}
            variant="default"
            onClick={onSaveConfig}
            icon={<Icon svg={<Icons.SaveOutline />} />}
          >
            Save as Default
          </Button>
          <Tooltip>
            Saves the current configuration as the default for{" "}
            {ModelProviders[instance.model.provider] ?? "this provider"}.
          </Tooltip>
        </TooltipTrigger>
      }
    >
      <Suspense>
        <ModelConfigDialogContent {...props} />
      </Suspense>
    </Dialog>
  );
}

interface ModelConfigDialogContentProps extends ModelConfigButtonProps {}
function ModelConfigDialogContent(props: ModelConfigDialogContentProps) {
  const { playgroundInstanceId } = props;
  const instance = usePlaygroundContext((state) =>
    state.instances.find((instance) => instance.id === playgroundInstanceId)
  );

  if (!instance) {
    throw new Error(
      `Playground instance ${props.playgroundInstanceId} not found`
    );
  }
  const modelConfigByProvider = usePreferencesContext(
    (state) => state.modelConfigByProvider
  );

  const updateInstance = usePlaygroundContext((state) => state.updateInstance);
  const updateModel = usePlaygroundContext((state) => state.updateModel);

  const query = useLazyLoadQuery<ModelConfigButtonDialogQuery>(
    graphql`
      query ModelConfigButtonDialogQuery($providerKey: GenerativeProviderKey!) {
        ...ModelProviderPickerFragment
        ...ModelPickerFragment @arguments(providerKey: $providerKey)
      }
    `,
    {
      providerKey: instance.model.provider,
    }
  );

  const onModelNameChange = useCallback(
    (modelName: string) => {
      updateModel({
        instanceId: playgroundInstanceId,
        model: {
          provider: instance.model.provider,
          modelName,
        },
        modelConfigByProvider,
      });
    },
    [
      instance.model.provider,
      modelConfigByProvider,
      playgroundInstanceId,
      updateModel,
    ]
  );

  const updateProvider = useCallback(
    (provider: ModelProvider) => {
      if (provider === instance.model.provider) {
        return;
      }
      const savedProviderConfig = modelConfigByProvider[provider];
      const patch: Partial<PlaygroundInstance> = {
        model: {
          ...instance.model,
          // Don't update the invocation parameters with the saved config, because the user may want to retain those params across provider changes
          // Only update the model name
          modelName: savedProviderConfig?.modelName ?? null,
          apiVersion: savedProviderConfig?.apiVersion ?? null,
          endpoint: savedProviderConfig?.endpoint ?? null,
          provider,
        },
        tools: convertInstanceToolsToProvider({
          instanceTools: instance.tools,
          provider,
        }),
      };
      if (instance.template.__type === "chat") {
        patch.template = {
          __type: "chat",
          messages: instance.template.messages.map((message) => {
            return {
              ...message,
              toolCalls: convertMessageToolCallsToProvider({
                toolCalls: message.toolCalls,
                provider,
              }),
            };
          }),
        };
      }
      updateInstance({
        instanceId: playgroundInstanceId,
        patch,
      });
    },
    [
      instance.model,
      instance.template,
      instance.tools,
      modelConfigByProvider,
      playgroundInstanceId,
      updateInstance,
    ]
  );

  return (
    <form css={modelConfigFormCSS}>
      <ModelProviderPicker
        provider={instance.model.provider}
        query={query}
        onChange={updateProvider}
      />
      {instance.model.provider === "AZURE_OPENAI" ? (
        <AzureOpenAiModelConfigFormField instance={instance} />
      ) : (
        <ModelPicker
          modelName={instance.model.modelName}
          provider={instance.model.provider}
          query={query}
          onChange={onModelNameChange}
        />
      )}
      <Suspense>
        <InvocationParametersFormFields instanceId={playgroundInstanceId} />
      </Suspense>
    </form>
  );
}
