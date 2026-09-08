import { useI18n } from 'vue-i18n'
import {
  NUMERIC_CONFIG_CONSTRAINTS,
  PORT_RECOVERY_CONSTRAINT,
  isNumericValueValid,
  type NumericConfigKey,
  type NumericConstraint,
} from '@shared/configConstraints'

export function usePreferenceNumericValidation() {
  const { t } = useI18n()

  const constraint = (key: NumericConfigKey): NumericConstraint => NUMERIC_CONFIG_CONSTRAINTS[key]

  const fieldProps = (value: unknown, rule: NumericConstraint): { validationStatus?: 'error'; feedback?: string } => {
    if (isNumericValueValid(value, rule)) {
      return {}
    }
    return {
      validationStatus: 'error' as const,
      feedback: t('preferences.value-range-error', { min: rule.min, max: rule.max }),
    }
  }

  const configFieldProps = (key: NumericConfigKey, value: unknown) => fieldProps(value, constraint(key))

  const areConfigFieldsValid = (values: Partial<Record<NumericConfigKey, unknown>>): boolean =>
    Object.entries(values).every(([key, value]) => isNumericValueValid(value, constraint(key as NumericConfigKey)))

  return {
    constraint,
    fieldProps,
    configFieldProps,
    areConfigFieldsValid,
    portRecoveryConstraint: PORT_RECOVERY_CONSTRAINT,
  }
}
