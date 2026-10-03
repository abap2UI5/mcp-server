CLASS zcl_bench_05 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_field,
        value TYPE string,
        state TYPE string,
        text  TYPE string,
      END OF ty_s_field.
    DATA name  TYPE ty_s_field.
    DATA email TYPE ty_s_field.
    DATA age   TYPE ty_s_field.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS validate
      RETURNING
        VALUE(result) TYPE abap_bool.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_05 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `xmlns:form`   v = `sap.ui.layout.form`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Registration` ).

    page->ele( n = `SimpleForm` ns = `form`
        )->a( n = `editable` v = `true`
        )->a( n = `layout`   v = `ResponsiveGridLayout`

        )->ele( n = `content` ns = `form`

            )->tag( `Label`
                )->a( n = `text` v = `Name`
            )->tag( `Input`
                )->a( n = `value`          v = client->_bind( name-value )
                )->a( n = `valueState`     v = client->_bind( name-state )
                )->a( n = `valueStateText` v = client->_bind( name-text )
            )->tag( `Label`
                )->a( n = `text` v = `Email`
            )->tag( `Input`
                )->a( n = `value`          v = client->_bind( email-value )
                )->a( n = `type`           v = `Email`
                )->a( n = `valueState`     v = client->_bind( email-state )
                )->a( n = `valueStateText` v = client->_bind( email-text )
            )->tag( `Label`
                )->a( n = `text` v = `Age`
            )->tag( `Input`
                )->a( n = `value`          v = client->_bind( age-value )
                )->a( n = `type`           v = `Number`
                )->a( n = `valueState`     v = client->_bind( age-state )
                )->a( n = `valueStateText` v = client->_bind( age-text )
            )->tag( `Label`
            )->tag( `Button`
                )->a( n = `text`  v = `Register`
                )->a( n = `type`  v = `Emphasized`
                )->a( n = `press` v = client->_event( `REGISTER` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `REGISTER`.
        IF validate( ) = abap_true.
          client->message_toast_display( |Registered { name-value }| ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

  METHOD validate.

    model_init( ).
    result = abap_true.

    IF condense( name-value ) IS INITIAL.
      name-state = `Error`.
      name-text  = `Enter your name`.
      result     = abap_false.
    ENDIF.

    IF NOT matches( val = email-value regex = `[^@\s]+@[^@\s]+\.[^@\s]+` ).
      email-state = `Error`.
      email-text  = `Enter a valid email address`.
      result      = abap_false.
    ENDIF.

    DATA(age_text) = condense( age-value ).
    IF age_text IS INITIAL OR NOT matches( val = age_text regex = `\d{1,3}` ).
      age-state = `Error`.
      age-text  = `Enter your age as a number`.
      result    = abap_false.
    ELSE.
      DATA(years) = CONV i( age_text ).
      IF years < 18 OR years > 99.
        age-state = `Error`.
        age-text  = `The age must be between 18 and 99`.
        result    = abap_false.
      ENDIF.
    ENDIF.

  ENDMETHOD.

  METHOD model_init.

    name-state  = `None`.
    name-text   = ``.
    email-state = `None`.
    email-text  = ``.
    age-state   = `None`.
    age-text    = ``.

  ENDMETHOD.

ENDCLASS.
